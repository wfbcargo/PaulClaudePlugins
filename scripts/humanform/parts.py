"""L4 parts: design variants of a region, judge them together, keep the good ones.

    variants = parts.variants("face", n=8, seed=3, sex="female")        # [{"name", "targets"}]
    sheet_png = views.variant_grid("Mara", out_png, variants, region="face")
    # one critic call judges every row of the grid; keep what it accepts:
    parts.store(human, "face", variants[2], tags=["soft", "round"], critic=verdict, sex="female")
    library.apply(other_body, part_card); scaffold.fit_face(other_body, lm)   # adapt to its measurements

A **design** changes a region's look through MPFB's style targets - the nose's hump and tip, lip
volume, jaw and chin, cheek volume, brow angle, ear shape - and leaves alone the targets the fit
uses to hold ANSUR's measurements (head breadth and depth, eye spacing, face height). Applying a
design and then refitting the face keeps the measurements and the look together.
"""

from __future__ import annotations

import os

import numpy as np

from . import library, scaffold

# (target stem in its group, sided, (positive suffix, negative suffix), amplitude) per region.
# Amplitudes are what reads as a different person without caricature; measured on the contact sheets.
STYLE = {
    "face": [
        (("nose", "nose-hump", False, ("incr", "decr")), 0.6),
        (("nose", "nose-point-width", False, ("incr", "decr")), 0.5),
        (("nose", "nose-nostrils-width", False, ("incr", "decr")), 0.5),
        (("nose", "nose-point", False, ("up", "down")), 0.5),
        (("nose", "nose-width2", False, ("incr", "decr")), 0.4),
        (("mouth", "mouth-upperlip-volume", False, ("incr", "decr")), 0.6),
        (("mouth", "mouth-lowerlip-volume", False, ("incr", "decr")), 0.6),
        (("mouth", "mouth-scale-horiz", False, ("incr", "decr")), 0.4),
        (("mouth", "mouth-angles", False, ("up", "down")), 0.3),
        (("chin", "chin-prominent", False, ("incr", "decr")), 0.6),
        (("chin", "chin-width", False, ("incr", "decr")), 0.6),
        (("chin", "chin-bones", False, ("incr", "decr")), 0.6),
        (("cheek", "cheek-volume", True, ("incr", "decr")), 0.6),
        (("cheek", "cheek-inner", True, ("incr", "decr")), 0.5),
        (("eyebrows", "eyebrows-angle", False, ("up", "down")), 0.5),
        (("eyes", "eye-bag", True, ("incr", "decr")), 0.4),
        (("eyes", "eye-eyefold-angle", True, ("up", "down")), 0.4),
        (("eyes", "eye-height2", True, ("incr", "decr")), 0.4),
        (("ears", "ear-scale", True, ("incr", "decr")), 0.4),
        (("ears", "ear-flap", True, ("incr", "decr")), 0.5),
        (("forehead", "forehead-temple", False, ("incr", "decr")), 0.5),
    ],
}


def _keys(stem, sided, suffixes):
    sides = ("l-", "r-") if sided else ("",)
    return [(f"hf:{side}{stem}-{suffixes[0]}", f"hf:{side}{stem}-{suffixes[1]}") for side in sides]


def variants(region="face", n=8, seed=0, share=0.6, strength=1.0, name=None):
    """n random designs: each moves a random `share` of the region's style targets, within their
    amplitudes times `strength`, symmetrically."""
    rng = np.random.default_rng(seed)
    table = STYLE[region]
    learned = amplitude_scale(region)       # shrinks targets that critics keep rejecting
    out = []
    for i in range(n):
        targets = {}
        for (group, stem, sided, suffixes), amp in table:
            if rng.random() > share:
                continue
            amp = amp * learned.get(stem, 1.0)
            w = float(rng.uniform(-amp, amp) * strength)
            for pos, neg in _keys(stem, sided, suffixes):
                targets[pos] = round(max(w, 0.0), 3)
                targets[neg] = round(max(-w, 0.0), 3)
        out.append({"name": f"{name or region}-{seed}-{i}", "region": region, "targets": targets})
    return out


def apply(human, variant):
    """Set a design's style targets (clearing the region's other style targets first)."""
    stems = {stem for (_, stem, _, _), _ in STYLE[variant["region"]]}
    kb = human.data.shape_keys.key_blocks
    for key in kb:
        if key.name.startswith("hf:") and any(st in key.name for st in stems):
            key.value = 0.0
    card = {"kind": "part", "region": variant["region"], "payload": {"targets": variant["targets"]}}
    library.apply(human, card)


def store(human, region, variant, tags=(), critic=None, sex=None, style=None, thumb=None):
    """Keep a judged design as a library part (only its style targets, not the body's fitted ones)."""
    apply(human, variant)
    nonzero = {k: v for k, v in variant["targets"].items() if abs(v) > 1e-4}
    payload = {"targets": nonzero, "clears_region": False, "style_stems": sorted(
        {stem for (_, stem, _, _), _ in STYLE[region]})}
    card = {"schema": library.SCHEMA, "kind": "part", "region": region, "name": variant["name"], "tags": list(tags),
            "sex": sex, "style": style, "topology": library.TOPOLOGY, "payload": payload,
            "quality": {"critic": critic}, "source": "designed",
            "created": __import__("datetime").datetime.now().isoformat(timespec="seconds")}
    card["id"] = library._card_id(f"{region}-{variant['name']}", payload)
    return library._store(card, thumb)


# ------------------------------------------------------------------------------------------------
# learning from verdicts: which style targets keep appearing in rejected designs

MIN_JUDGED = 10          # below this many judged designs, amplitudes are not adjusted


def _stats_path(region):
    return os.path.join(library.root(), "stats", f"style_{region}.json")


def style_stats(region):
    try:
        with open(_stats_path(region), encoding="utf-8") as fh:
            return __import__("json").load(fh)
    except FileNotFoundError:
        return {"judged": 0, "stems": {}}


def _magnitudes(variant):
    mags = {}
    for (group, stem, sided, suffixes), amp in STYLE[variant["region"]]:
        w = 0.0
        for pos, neg in _keys(stem, sided, suffixes):
            w = max(w, abs(variant["targets"].get(pos, 0.0)), abs(variant["targets"].get(neg, 0.0)))
        mags[stem] = w / amp          # as a share of the amplitude it was drawn from
    return mags


def record_verdicts(variants_list, verdict):
    """Add a batch critic's keep/reject per panel to the region's per-target statistics. Panels with
    no style targets (the base) are skipped."""
    import json
    region = verdict.get("region", "face")
    st = style_stats(region)
    for panel in verdict["panels"]:
        v = variants_list[panel["panel"]]
        if not v["targets"]:
            continue
        st["judged"] += 1
        for stem, share in _magnitudes(v).items():
            e = st["stems"].setdefault(stem, {"kept": 0.0, "rejected": 0.0, "kept_n": 0, "rejected_n": 0})
            key = "kept" if panel.get("keep") else "rejected"
            e[key] += share
            e[key + "_n"] += 1
    os.makedirs(os.path.dirname(_stats_path(region)), exist_ok=True)
    with open(_stats_path(region), "w", encoding="utf-8") as fh:
        json.dump(st, fh, indent=1)
    return st


def amplitude_scale(region):
    """Per target, how much to shrink its amplitude: targets used harder in rejected designs than in
    kept ones shrink toward half. Nothing changes until MIN_JUDGED designs have been judged."""
    st = style_stats(region)
    out = {}
    if st["judged"] < MIN_JUDGED:
        return out
    for stem, e in st["stems"].items():
        kept = e["kept"] / max(e["kept_n"], 1)
        rej = e["rejected"] / max(e["rejected_n"], 1)
        if e["rejected_n"] >= 2 and rej > kept:
            out[stem] = float(np.clip(1.0 - (rej - kept), 0.5, 1.0))
    return out
