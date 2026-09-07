#!/usr/bin/env python3
"""
generate_topology.py (SUPRA edition)

Auto-diagrams the network topology straight from parsed.json (the output of
parse_fortigate_conf.py) -- no screenshot, no manual drawing. Uses Graphviz
(`dot`) with HTML-like node labels to render "card" style boxes (colored
header strip + body, rounded corners) grouped into colored zone panels
(WAN / LAN / DMZ / VPN / Fabric), styled with the SUPRA palette -- aiming
for the same professional, sober look as a hand-drawn Visio/drawio diagram
without needing either tool.

Design goal: clean but *specific* -- every interface that's actually part of
the design (has an IP, a WAN/DMZ role, is an SD-WAN member, or is referenced
by a firewall policy) gets its own labeled card with IP/gateway/subnet-name.
Anything genuinely unused (no IP, no role, not referenced anywhere) is
listed once in a compact note box instead of cluttering the diagram -- so
nothing is silently hidden, but nothing dead gets a card either.

Renders:
  - Internet cloud -> WAN/SD-WAN zone panel -> firewall
  - Firewall -> LAN / DMZ / fabric / VPN zone panels, each card labeled with
    IP and, when it matches a firewall address object, the network's name
  - HA peer link, only drawn if the .conf shows a *real* HA config (mode
    a-p/a-a, hbdev, group-id/group-name -- NOT the default boilerplate
    `config system ha / set override disable / end` every standalone unit
    ships with)
  - FortiAnalyzer node + "envio de logs" edges, if a FAZ device is present
  - A card-style legend and a note box listing "sin uso" interfaces

Usage:
    python3 generate_topology.py parsed.json -o topology.png
    (also writes topology.dot next to it -- editable / re-renderable with any
    Graphviz-aware tool, e.g. reimported into draw.io via the Graphviz import)
"""
import argparse
import ipaddress
import json
import re
import subprocess
import sys
from pathlib import Path

# Ver check_report.py: evita que una consola sin UTF-8 crashee con
# UnicodeEncodeError en vez de solo mostrar '?' para un caracter no soportado.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors='replace')
    except AttributeError:
        pass

# ---------------------------------------------------------------- palette --

NAVY = "#1F3864"       # SUPRA brand navy -- firewall, WAN
NAVY_LIGHT = "#EAF1FB"
NAVY_BORDER = "#8FAADC"

GREEN = "#2E7D32"      # LAN
GREEN_LIGHT = "#EAF7EC"
GREEN_BORDER = "#A9D9AE"

ORANGE = "#B45F06"     # DMZ
ORANGE_LIGHT = "#FDF1E8"
ORANGE_BORDER = "#F0C29B"

BLUE = "#0B5394"       # VPN tunnels
BLUE_LIGHT = "#E8F1FB"
BLUE_BORDER = "#9FC5E8"

PURPLE = "#674EA7"     # Fabric / FortiSwitch
PURPLE_LIGHT = "#F1EEFB"
PURPLE_BORDER = "#C6B6E8"

GRAY = "#595959"       # HA peer / neutral
GRAY_LIGHT = "#F2F2F2"
GRAY_BORDER = "#BFBFBF"

FAZ_GREEN = "#38761D"
FAZ_LIGHT = "#EAF7EC"
FAZ_BORDER = "#A9D9AE"

TEXT_DARK = "#262626"


def is_real_ha(ha):
    if not ha:
        return False
    mode = ha.get("mode", "")
    if mode and mode != "standalone":
        return True
    if any(k in ha for k in ("hbdev", "group-id", "group-name", "password")):
        return True
    return False


def sanitize(name):
    return re.sub(r"[^a-zA-Z0-9_]", "_", name)


def parse_ip_mask(ip):
    parts = ip.split()
    if len(parts) != 2:
        return None
    addr, mask = parts
    try:
        return ipaddress.IPv4Interface(f"{addr}/{mask}")
    except Exception:
        return None


def short_ip(ip):
    iface = parse_ip_mask(ip)
    if iface:
        return f"{iface.ip}/{iface.network.prefixlen}"
    return ip


def match_address_name(iface, addresses):
    if not iface:
        return None
    for a in addresses:
        net = parse_ip_mask(a["subnet"]) if " " in a.get("subnet", "") else None
        if net and net.network == iface.network:
            return a["name"]
    return None


def esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def card(node_id, header, lines, header_color, border_color, *, header_fontcolor="white",
         width_px=None, big=False):
    """Render an HTML-like 'card' node: colored header strip + white body."""
    hp = "7" if big else "5"
    hfs = "11" if big else "10"
    bfs = "10" if big else "9"
    body_rows = "".join(
        f'<TR><TD ALIGN="CENTER" CELLPADDING="3"><FONT FACE="Helvetica" POINT-SIZE="{bfs}" COLOR="{TEXT_DARK}">{esc(l)}</FONT></TD></TR>'
        for l in lines if l
    )
    width_attr = f' WIDTH="{width_px}"' if width_px else ""
    table = (
        f'<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" '
        f'COLOR="{border_color}" BGCOLOR="white" STYLE="ROUNDED"{width_attr}>'
        f'<TR><TD BGCOLOR="{header_color}" CELLPADDING="{hp}" STYLE="ROUNDED"><FONT FACE="Helvetica-Bold" '
        f'POINT-SIZE="{hfs}" COLOR="{header_fontcolor}">{esc(header)}</FONT></TD></TR>'
        f'{body_rows}'
        f'</TABLE>'
    )
    return f'  {node_id} [shape=plain, margin=0, label=<{table}>];'


def zone_open(cluster_id, title, panel_color, border_color, text_color):
    return (
        f'  subgraph {cluster_id} {{\n'
        f'    style="rounded,filled"; fillcolor="{panel_color}"; color="{border_color}"; penwidth=1.4;\n'
        f'    margin=18; fontname="Helvetica-Bold"; fontsize=11; fontcolor="{text_color}";\n'
        f'    label=<<FONT FACE="Helvetica-Bold" POINT-SIZE="11" COLOR="{text_color}">{esc(title)}</FONT>>;\n'
    )


def build_dot(parsed):
    devices = parsed.get("devices", {})

    def kind(dev):
        header = " ".join(dev.get("_header", []))
        return "faz" if re.search(r"FAZ", header, re.I) else "fgt"

    firewalls = [(hn, d) for hn, d in devices.items() if kind(d) == "fgt"]
    analyzers = [(hn, d) for hn, d in devices.items() if kind(d) == "faz"]

    L = []
    L.append("digraph topology {")
    L.append('  rankdir=TB; nodesep=0.5; ranksep=0.65; compound=true; splines=ortho;')
    L.append('  bgcolor="white"; pad="0.3"; fontname="Helvetica";')
    L.append('  node [fontname="Helvetica", fontsize=10];')
    L.append(f'  edge [fontname="Helvetica", fontsize=8, color="#8496B0", penwidth=1.3, arrowsize=0.7];')

    hostnames = ", ".join(hn for hn, _ in firewalls)
    L.append(
        f'  labelloc="t"; fontsize=17; fontname="Helvetica-Bold"; fontcolor="{NAVY}"; '
        f'label=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0">'
        f'<TR><TD ALIGN="CENTER"><FONT FACE="Helvetica-Bold" POINT-SIZE="17" COLOR="{NAVY}">Topologia de red &#8212; {esc(hostnames)}</FONT></TD></TR>'
        f'<TR><TD ALIGN="CENTER"><FONT FACE="Helvetica" POINT-SIZE="10" COLOR="#7F7F7F"><I>Diagrama generado automaticamente desde la configuracion (sin captura de pantalla) &#8212; SUPRA</I></FONT></TD></TR>'
        f'</TABLE>>;'
    )

    # Internet cloud
    L.append(
        f'  Internet [shape=plain, margin=0, label=<'
        f'<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="8" COLOR="{GRAY_BORDER}" BGCOLOR="{GRAY_LIGHT}" STYLE="ROUNDED">'
        f'<TR><TD ALIGN="CENTER"><FONT FACE="Helvetica-Bold" POINT-SIZE="12" COLOR="{GRAY}">INTERNET</FONT></TD></TR>'
        f'<TR><TD ALIGN="CENTER"><FONT FACE="Helvetica" POINT-SIZE="8" COLOR="{GRAY}">Proveedores / enlaces WAN</FONT></TD></TR>'
        f'</TABLE>>];'
    )

    fw_ids = []
    unused_summary = {}
    bottom_anchors = []

    for hostname, dev in firewalls:
        fwid = "FW_" + sanitize(hostname)
        fw_ids.append(fwid)
        alias = dev.get("global", {}).get("alias", "")
        body = [alias] if alias else []
        L.append(card(fwid, f"FIREWALL — {hostname}", body, NAVY, NAVY, big=True))

        addresses = dev.get("addresses", [])
        referenced = set(dev.get("referenced_interfaces", []))
        sdwan = dev.get("sdwan")
        sdwan_members = {m["interface"]: m for m in (sdwan or {}).get("members", [])}
        sdwan_active = bool(sdwan and sdwan.get("status") == "enable" and sdwan_members)

        wan_nodes, lan_nodes, dmz_nodes, vpn_nodes, fabric_nodes = [], [], [], [], []

        for iface in dev.get("interfaces", []):
            name = iface["name"]
            role = iface.get("role", "")
            ip = iface.get("ip", "")
            iface_obj = parse_ip_mask(ip) if ip else None
            node_id = f"{fwid}_{sanitize(name)}"

            is_wan = role == "wan"
            is_dmz = role == "dmz"
            is_sdwan_member = name in sdwan_members
            is_fabric = iface.get("type") == "aggregate" and "fortilink" in name.lower()
            has_meaningful_alias = bool(iface.get("alias")) and iface.get("type") == "tunnel"
            is_used_elsewhere = name in referenced and (ip or role)

            if not (is_wan or is_dmz or ip or is_sdwan_member or is_fabric or has_meaningful_alias or is_used_elsewhere):
                unused_summary.setdefault(hostname, []).append(name)
                continue

            lines = []
            if iface.get("alias"):
                lines.append(iface["alias"])
            if ip:
                lines.append(short_ip(ip))
                net_name = match_address_name(iface_obj, addresses)
                if net_name:
                    lines.append(f"red: {net_name}")
            if is_sdwan_member:
                gw = sdwan_members[name].get("gateway", "")
                if gw:
                    lines.append(f"GW: {gw}")

            if is_wan or is_sdwan_member:
                L.append(card(node_id, name, lines, NAVY, NAVY_BORDER))
                wan_nodes.append(node_id)
                L.append(f'  Internet -> {node_id} [color="{NAVY_BORDER}"];')
                L.append(f'  {node_id} -> {fwid} [color="{NAVY_BORDER}"];')
            elif is_dmz:
                L.append(card(node_id, name, lines, ORANGE, ORANGE_BORDER))
                dmz_nodes.append(node_id)
                L.append(f'  {fwid} -> {node_id} [color="{ORANGE_BORDER}"];')
            elif is_fabric:
                L.append(card(node_id, name, lines + ["FortiSwitch fabric"], PURPLE, PURPLE_BORDER))
                fabric_nodes.append(node_id)
                L.append(f'  {fwid} -> {node_id} [label="fabric", style=dashed, color="{PURPLE_BORDER}", fontcolor="{PURPLE}"];')
            elif has_meaningful_alias:
                L.append(card(node_id, name, lines + ["tunel VPN"], BLUE, BLUE_BORDER))
                vpn_nodes.append(node_id)
                L.append(f'  {fwid} -> {node_id} [style=dotted, color="{BLUE_BORDER}"];')
            else:
                tag = " (LAN)" if role == "lan" else ""
                L.append(card(node_id, name + tag, lines, GREEN, GREEN_BORDER))
                lan_nodes.append(node_id)
                L.append(f'  {fwid} -> {node_id} [color="{GREEN_BORDER}"];')
                bottom_anchors.append(node_id)

        if wan_nodes:
            zone_names = ", ".join(sdwan.get("zones", [])) if sdwan_active else ""
            title = f"ZONA WAN / SD-WAN ({esc(zone_names)})" if zone_names else "ZONA WAN"
            cl = f"cluster_wan_{sanitize(hostname)}"
            L.append(zone_open(cl, title, NAVY_LIGHT, NAVY_BORDER, NAVY))
            for n in wan_nodes:
                L.append(f"    {n};")
            L.append("  }")

        if lan_nodes:
            cl = f"cluster_lan_{sanitize(hostname)}"
            L.append(zone_open(cl, "ZONA LAN", GREEN_LIGHT, GREEN_BORDER, GREEN))
            for n in lan_nodes:
                L.append(f"    {n};")
            L.append("  }")

        if dmz_nodes:
            cl = f"cluster_dmz_{sanitize(hostname)}"
            L.append(zone_open(cl, "ZONA DMZ", ORANGE_LIGHT, ORANGE_BORDER, ORANGE))
            for n in dmz_nodes:
                L.append(f"    {n};")
            L.append("  }")

        if vpn_nodes:
            cl = f"cluster_vpn_{sanitize(hostname)}"
            L.append(zone_open(cl, "TUNELES VPN", BLUE_LIGHT, BLUE_BORDER, BLUE))
            for n in vpn_nodes:
                L.append(f"    {n};")
            L.append("  }")

        if fabric_nodes:
            cl = f"cluster_fabric_{sanitize(hostname)}"
            L.append(zone_open(cl, "FORTILINK / FABRIC", PURPLE_LIGHT, PURPLE_BORDER, PURPLE))
            for n in fabric_nodes:
                L.append(f"    {n};")
            L.append("  }")

    # HA peer link -- only if genuinely configured
    for hostname, dev in firewalls:
        fwid = "FW_" + sanitize(hostname)
        if is_real_ha(dev.get("ha")):
            peer_id = f"{fwid}_ha_peer"
            L.append(card(peer_id, "Firewall par (HA)", ["Sincronizacion HA"], GRAY, GRAY_BORDER))
            L.append(f'  {fwid} -> {peer_id} [label="HA sync", style=dashed, dir=both, color="{GRAY}", fontcolor="{GRAY}"];')

    # FortiAnalyzer
    for hostname, dev in analyzers:
        fazid = "FAZ_" + sanitize(hostname)
        L.append(card(fazid, f"FortiAnalyzer — {hostname}", [], FAZ_GREEN, FAZ_GREEN, header_fontcolor="white", big=True))
        for fwid in fw_ids:
            L.append(f'  {fwid} -> {fazid} [label="logs", style=dotted, color="{FAZ_GREEN}", fontcolor="{FAZ_GREEN}"];')

    # legend -- card style, single row, pinned below the diagram
    L.append('  subgraph cluster_legend {')
    L.append(f'    style="rounded"; color="{GRAY_BORDER}"; fontname="Helvetica-Bold"; fontsize=10; fontcolor="{GRAY}"; margin=14;')
    L.append('    label="Leyenda";')
    L.append('    {rank=same; leg_wan; leg_lan; leg_dmz; leg_vpn; leg_fab;}')
    L.append(card("leg_wan", "WAN / SD-WAN", [], NAVY, NAVY_BORDER))
    L.append(card("leg_lan", "LAN", [], GREEN, GREEN_BORDER))
    L.append(card("leg_dmz", "DMZ", [], ORANGE, ORANGE_BORDER))
    L.append(card("leg_vpn", "Tunel VPN", [], BLUE, BLUE_BORDER))
    L.append(card("leg_fab", "Fabric switch", [], PURPLE, PURPLE_BORDER))
    L.append('    leg_wan -> leg_lan -> leg_dmz -> leg_vpn -> leg_fab [style=invis];')
    L.append("  }")
    if bottom_anchors:
        L.append(f'  {bottom_anchors[0]} -> leg_wan [style=invis, weight=0, constraint=true];')

    # unused-interfaces footnote
    if unused_summary:
        parts = []
        for hn, names in unused_summary.items():
            parts.append(f"{hn}: {', '.join(sorted(names))}")
        note = " | ".join(parts)
        words = note.split(" ")
        wrapped, cur = [], ""
        for w in words:
            if len(cur) + len(w) + 1 > 70:
                wrapped.append(cur)
                cur = w
            else:
                cur = f"{cur} {w}".strip()
        if cur:
            wrapped.append(cur)
        note_lines = "".join(
            f'<TR><TD ALIGN="LEFT"><FONT FACE="Helvetica" POINT-SIZE="8" COLOR="#7F7F7F">{esc(w)}</FONT></TD></TR>'
            for w in wrapped
        )
        L.append(
            f'  unused_note [shape=plain, margin=0, label=<'
            f'<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" COLOR="{GRAY_BORDER}" BGCOLOR="#FAFAFA" STYLE="ROUNDED">'
            f'<TR><TD ALIGN="LEFT"><FONT FACE="Helvetica-Bold" POINT-SIZE="8" COLOR="{GRAY}">NOTA &#8212; interfaces sin IP/rol/uso detectado (no dibujadas):</FONT></TD></TR>'
            f'{note_lines}'
            f'</TABLE>>];'
        )
        if bottom_anchors:
            L.append(f'  {bottom_anchors[0]} -> unused_note [style=invis, weight=0];')

    L.append("}")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("parsed_json")
    ap.add_argument("-o", "--output", default="topology.png")
    args = ap.parse_args()

    parsed = json.loads(Path(args.parsed_json).read_text(encoding="utf-8"))
    dot_src = build_dot(parsed)

    dot_path = Path(args.output).with_suffix(".dot")
    dot_path.write_text(dot_src, encoding="utf-8")

    fmt = Path(args.output).suffix.lstrip(".") or "png"
    result = subprocess.run(
        ["dot", f"-T{fmt}", "-Gdpi=170", str(dot_path), "-o", args.output],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(1)
    print(f"OK: {dot_path} y {args.output} generados", file=sys.stderr)


if __name__ == "__main__":
    main()
