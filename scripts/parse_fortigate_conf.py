#!/usr/bin/env python3
"""
parse_fortigate_conf.py

Parses one or more FortiGate CLI configuration backup files (.conf) into a
structured JSON document that a report generator can consume directly,
without needing GUI screenshots.

FortiGate config syntax (simplified grammar this parser handles):

    config <block name...>
        edit <id-or-"name">        # table entry (repeatable)
            set <key> <value...>
            config <sub-block>     # nested table/singleton
                ...
            end
        next
        set <key> <value...>       # singleton block (no edit/next)
    end

Usage:
    python parse_fortigate_conf.py FW1.conf [FW2.conf ...] -o parsed.json

If multiple files are given (e.g. an HA pair, or a firewall + separate vdom
export), each is parsed independently and merged under its own key using the
device hostname (from `config system global` -> alias/hostname) or the file
name if hostname can't be determined.
"""
import argparse
import json
import re
import sys
from pathlib import Path

# Ver check_report.py: evita que una consola sin UTF-8 crashee con
# UnicodeEncodeError en vez de solo mostrar '?' para un caracter no soportado.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors='replace')
    except AttributeError:
        pass


def tokenize_value(rest):
    """Split the remainder of a `set key <rest>` line into a list of tokens,
    respecting double-quoted strings."""
    tokens = []
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"|(\S+)', rest):
        if m.group(1) is not None:
            tokens.append(m.group(1).replace('\\"', '"'))
        else:
            tokens.append(m.group(2))
    return tokens


def parse_config_block(lines, i, n):
    """Parse a `config ... end` block starting at lines[i] (which is the
    `config ...` line itself). Returns (node, next_index).

    node = {
        "kind": "config",
        "name": "<block name>",
        "entries": {entry_key: <node-of-entries>} or None,
        "set": {key: [tokens]},
        "children": [nested config nodes not inside an edit],
    }
    """
    header = lines[i].strip()
    name = header[len("config "):].strip()
    node = {"kind": "config", "name": name, "entries": None, "set": {}, "children": []}
    i += 1
    entries = {}
    has_edit = False
    while i < n:
        line = lines[i].strip()
        if line == "end":
            i += 1
            break
        if not line or line.startswith("#"):
            i += 1
            continue
        if line.startswith("edit "):
            has_edit = True
            key = tokenize_value(line[len("edit "):].strip())
            entry_key = key[0] if key else f"_row{len(entries)}"
            entry_node = {"set": {}, "children": []}
            i += 1
            while i < n:
                l2 = lines[i].strip()
                if l2 == "next":
                    i += 1
                    break
                if not l2 or l2.startswith("#"):
                    i += 1
                    continue
                if l2.startswith("config "):
                    sub, i = parse_config_block(lines, i, n)
                    entry_node["children"].append(sub)
                    continue
                if l2.startswith("set "):
                    m = re.match(r"set\s+(\S+)\s*(.*)$", l2)
                    if m:
                        entry_node["set"][m.group(1)] = tokenize_value(m.group(2))
                    i += 1
                    continue
                if l2.startswith("unset ") or l2.startswith("append ") or l2.startswith("next"):
                    i += 1
                    continue
                # unknown line inside entry, skip
                i += 1
            entries[entry_key] = entry_node
            continue
        if line.startswith("config "):
            sub, i = parse_config_block(lines, i, n)
            node["children"].append(sub)
            continue
        if line.startswith("set "):
            m = re.match(r"set\s+(\S+)\s*(.*)$", line)
            if m:
                node["set"][m.group(1)] = tokenize_value(m.group(2))
            i += 1
            continue
        # unknown line at this level (unset, next stray, etc.)
        i += 1
    if has_edit:
        node["entries"] = entries
    return node, i


def parse_file(path):
    text = Path(path).read_text(errors="replace")
    lines = text.splitlines()
    n = len(lines)
    top = {}
    header_comments = [l for l in lines[:6] if l.startswith("#")]
    i = 0
    while i < n:
        line = lines[i].strip()
        if line.startswith("config "):
            node, i = parse_config_block(lines, i, n)
            top[node["name"]] = node
        else:
            i += 1
    return top, header_comments


def find_block(top, *name_variants):
    for name in name_variants:
        if name in top:
            return top[name]
    return None


def sjoin(entry_set, key, default=""):
    v = entry_set.get(key)
    if v is None:
        return default
    return " ".join(v)


def extract_global(top):
    blk = find_block(top, "system global")
    out = {}
    if blk:
        for k in ("hostname", "alias", "timezone"):
            if k in blk["set"]:
                out[k] = sjoin(blk["set"], k)
    return out


def extract_interfaces(top):
    blk = find_block(top, "system interface")
    result = []
    if not blk or not blk["entries"]:
        return result
    for name, e in blk["entries"].items():
        s = e["set"]
        result.append({
            "name": name,
            "vdom": sjoin(s, "vdom", "root"),
            "ip": sjoin(s, "ip"),
            "type": sjoin(s, "type"),
            "role": sjoin(s, "role"),
            "alias": sjoin(s, "alias"),
            "allowaccess": sjoin(s, "allowaccess"),
            "status": sjoin(s, "status", "up"),
            "mode": sjoin(s, "mode"),
        })
    return result


def extract_static_routes(top):
    blk = find_block(top, "router static")
    result = []
    if not blk or not blk["entries"]:
        return result
    for rid, e in blk["entries"].items():
        s = e["set"]
        result.append({
            "id": rid,
            "dst": sjoin(s, "dst", "0.0.0.0/0.0.0.0"),
            "gateway": sjoin(s, "gateway"),
            "device": sjoin(s, "device"),
            "distance": sjoin(s, "distance", "10"),
            "sdwan_zone": sjoin(s, "sdwan-zone"),
            "comment": sjoin(s, "comment"),
        })
    return result


def extract_ospf(top):
    blk = find_block(top, "router ospf")
    if not blk:
        return None
    out = {"router_id": sjoin(blk["set"], "router-id"), "areas": [], "networks": [], "interfaces": []}
    for child in blk.get("children", []):
        if child["name"] == "area" and child["entries"]:
            for aid, e in child["entries"].items():
                out["areas"].append({"id": aid, **{k: sjoin(e["set"], k) for k in e["set"]}})
        if child["name"] == "network" and child["entries"]:
            for nid, e in child["entries"].items():
                out["networks"].append({
                    "id": nid,
                    "prefix": sjoin(e["set"], "prefix"),
                    "area": sjoin(e["set"], "area"),
                })
        if child["name"] == "ospf-interface" and child["entries"]:
            for iid, e in child["entries"].items():
                out["interfaces"].append({
                    "name": iid,
                    "interface": sjoin(e["set"], "interface"),
                    "cost": sjoin(e["set"], "cost"),
                })
    return out


def extract_sdwan(top):
    blk = find_block(top, "system sdwan", "system virtual-wan-link")
    if not blk:
        return None
    out = {"status": sjoin(blk["set"], "status", "disable"), "zones": [], "members": []}
    for child in blk.get("children", []):
        if child["name"] == "zone" and child["entries"]:
            out["zones"] = list(child["entries"].keys())
        if child["name"] == "members" and child["entries"]:
            for mid, e in child["entries"].items():
                s = e["set"]
                out["members"].append({
                    "id": mid,
                    "interface": sjoin(s, "interface"),
                    "gateway": sjoin(s, "gateway"),
                    "zone": sjoin(s, "zone"),
                    "priority": sjoin(s, "priority"),
                })
    return out


def extract_addresses(top):
    """Only keep simple subnet-type address objects (name+subnet) — enough
    to label a LAN/DMZ interface with the network name used in policies.
    Address groups / FQDN / huge threat-feed lists are skipped on purpose."""
    blk = find_block(top, "firewall address")
    result = []
    if not blk or not blk["entries"]:
        return result
    for name, e in blk["entries"].items():
        s = e["set"]
        if "subnet" in s:
            result.append({"name": name, "subnet": sjoin(s, "subnet")})
    return result


def extract_firewall_policies(top):
    blk = find_block(top, "firewall policy")
    result = []
    if not blk or not blk["entries"]:
        return result

    def sort_key(rid):
        try:
            return (0, int(rid))
        except ValueError:
            return (1, rid)

    for rid in sorted(blk["entries"].keys(), key=sort_key):
        e = blk["entries"][rid]
        s = e["set"]
        result.append({
            "id": rid,
            "name": sjoin(s, "name", f"(sin nombre - id {rid})"),
            "srcintf": sjoin(s, "srcintf"),
            "dstintf": sjoin(s, "dstintf"),
            "srcaddr": sjoin(s, "srcaddr"),
            "dstaddr": sjoin(s, "dstaddr"),
            "service": sjoin(s, "service"),
            "action": sjoin(s, "action", "deny"),
            "nat": sjoin(s, "nat", "disable"),
            "utm_status": sjoin(s, "utm-status", "disable"),
            "av_profile": sjoin(s, "av-profile"),
            "application_list": sjoin(s, "application-list"),
            "webfilter_profile": sjoin(s, "webfilter-profile"),
            "ips_sensor": sjoin(s, "ips-sensor"),
            "logtraffic": sjoin(s, "logtraffic"),
            "comments": sjoin(s, "comments"),
        })
    return result


def extract_named_profiles(top, block_name, extra_keys=None):
    """Generic extractor for profile-style blocks: webfilter profile,
    application list, ips sensor, antivirus profile, etc. Returns just
    name + a handful of descriptive keys (profiles are often long; we keep
    it to what's useful for a report table)."""
    blk = find_block(top, block_name)
    result = []
    if not blk or not blk["entries"]:
        return result
    extra_keys = extra_keys or []
    for name, e in blk["entries"].items():
        s = e["set"]
        row = {"name": name, "comment": sjoin(s, "comment")}
        for k in extra_keys:
            row[k] = sjoin(s, k)
        result.append(row)
    return result


def extract_ha(top):
    blk = find_block(top, "system ha")
    if not blk:
        return None
    s = blk["set"]
    return {k: sjoin(s, k) for k in s}


def extract_admins(top):
    blk = find_block(top, "system admin")
    result = []
    if not blk or not blk["entries"]:
        return result
    for name, e in blk["entries"].items():
        s = e["set"]
        result.append({
            "name": name,
            "accprofile": sjoin(s, "accprofile"),
            "vdom": sjoin(s, "vdom"),
            "trusthost1": sjoin(s, "trusthost1"),
        })
    return result


def extract_referenced_interfaces(firewall_policies):
    """Every interface name that appears as srcintf/dstintf in at least one
    policy — used to decide whether an otherwise IP-less interface (a zone,
    an SD-WAN member, an aggregate) is actually "in use"."""
    used = set()
    for pol in firewall_policies:
        for field in ("srcintf", "dstintf"):
            used.update(pol.get(field, "").split())
    return sorted(used)


def extract_all(top):
    policies = extract_firewall_policies(top)
    return {
        "global": extract_global(top),
        "interfaces": extract_interfaces(top),
        "static_routes": extract_static_routes(top),
        "ospf": extract_ospf(top),
        "sdwan": extract_sdwan(top),
        "addresses": extract_addresses(top),
        "firewall_policies": policies,
        "referenced_interfaces": extract_referenced_interfaces(policies),
        "webfilter_profiles": extract_named_profiles(top, "webfilter profile"),
        "application_profiles": extract_named_profiles(top, "application list"),
        "ips_sensors": extract_named_profiles(top, "ips sensor"),
        "antivirus_profiles": extract_named_profiles(top, "antivirus profile"),
        "ha": extract_ha(top),
        "admins": extract_admins(top),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("conf_files", nargs="+", help="One or more FortiGate .conf files")
    ap.add_argument("-o", "--output", default="parsed.json")
    args = ap.parse_args()

    devices = {}
    for path in args.conf_files:
        top, header = parse_file(path)
        data = extract_all(top)
        hostname = data["global"].get("hostname") or Path(path).stem
        data["_source_file"] = Path(path).name
        data["_header"] = header
        devices[hostname] = data

    with open(args.output, "w") as f:
        json.dump({"devices": devices}, f, indent=2, ensure_ascii=False)
    print(f"OK: {len(devices)} device(s) parsed -> {args.output}", file=sys.stderr)
    for hn, d in devices.items():
        print(
            f"  - {hn}: {len(d['interfaces'])} interfaces, "
            f"{len(d['static_routes'])} rutas estáticas, "
            f"{len(d['firewall_policies'])} políticas, "
            f"{len(d['webfilter_profiles'])} perfiles web, "
            f"{len(d['application_profiles'])} perfiles app, "
            f"{len(d['ips_sensors'])} perfiles IPS, "
            f"{len(d['antivirus_profiles'])} perfiles AV, "
            f"ospf={'sí' if d['ospf'] else 'no'}, ha={'sí' if d['ha'] else 'no'}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
