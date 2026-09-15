"""One call from a brief to a checked, rigged body - reusing the library when it can.

    res = pipeline.make(sheet.new(name="Ines", sex="female", age=30, stature=1.70, build="athletic"),
                        out_dir=r"C:/scratch/ines", store=True)
    res["path"]      # "reuse", "warm" or "fresh"
    res["timing"]    # seconds per stage

The decision is made on ANSUR z-distance to the nearest stored body of the same sex and style:

    distance < REUSE   apply the stored body and measure once; if every residual is within
                       tolerance, no fit at all
    distance < WARM    fit starting from the stored body's solver parameters
    otherwise          fit from MPFB's macros

A result that passes humancheck can be stored (store=True), so the next similar brief is cheap.
"""

from __future__ import annotations

import time

import bpy
import numpy as np

from . import landmarks, library, measure, parts, scaffold, sheet, views

REUSE = 0.35
WARM = 1.6


def make(s, out_dir=None, store=False, use_library=True, contact_sheet=False, tags=(), verbose=False, eyes=True,
         face_part=None, hand_part=None, foot_part=None):
    """`face_part`, `hand_part`, `foot_part`: library parts (card or id) applied before the fit, so their
    look is kept and the measurements - moved by a hand or foot part's offsets - are solved for this body."""
    t = {}
    t0 = time.time()
    r = sheet.resolve(s)
    lm = landmarks.from_measurements(r["values"], s["sex"], s["style"], name=s["name"])
    t["sheet"] = time.time() - t0

    hits = library.find_bodies(r, k=1) if use_library else []
    nearest = hits[0] if hits else None
    path = "fresh"
    start = None
    t1 = time.time()
    human = scaffold.create(r["sheet"])
    build = s.get("build") if isinstance(s.get("build"), str) else None
    rep = None
    jac = {}
    reuse_check = None
    if nearest and nearest[0] < WARM:
        card = library.load(nearest[1]["id"])
        library.apply(human, card)
        start = card.get("solver_params")
        jac = card.get("jacobians") or {}
        path = "warm"
        if nearest[0] < REUSE:
            # try the stored body as it is: one measurement decides
            target = landmarks.as_measurements(lm)
            tol = scaffold._tolerances(scaffold.RESIDUALS, __import__("humanform").presets()["presets"][s["style"]]["ratios"],
                                       s["sex"], lm["stature"])
            m = scaffold._measure(human, s["sex"])
            res = scaffold._residuals(m, target, tol, scaffold.RESIDUALS)
            worst = int(np.argmax(np.abs(res)))
            reuse_check = {"max_tol": round(float(np.max(np.abs(res))), 3), "worst": scaffold.RESIDUALS[worst][0]}
            # as good as the fit that made it (a body can end a little outside tolerance on a hard brief)
            limit = max(1.0, 1.1 * float((card.get("quality") or {}).get("fit_max_tol") or 0.0))
            reuse_check["limit"] = round(limit, 3)
            if np.max(np.abs(res)) <= limit:
                path = "reuse"
                rep = {"params": start, "rms_tol": round(float(np.sqrt(np.mean(res ** 2))), 3), "measurements": 1,
                       "seconds": 0.0, "history": [], "residuals": []}
                if not jac.get("extremities"):
                    # stored before hands and feet were fitted: fit just those (under a second)
                    ext = scaffold.fit_extremities(human, lm, verbose=verbose, start=start)
                    if ext is not None:
                        rep["extremities"] = ext
    t["create"] = time.time() - t1

    for chosen in (face_part, hand_part, foot_part):
        if chosen is None:
            continue
        part = library.load(chosen if isinstance(chosen, str) else chosen["id"])
        library.apply(human, part)
        lm = parts.offset_landmarks(lm, part, s["sex"])     # a hand or foot design's size offsets
        rep = None                          # a new part means the stored fit no longer holds
    t2 = time.time()
    if rep is None:
        rep = scaffold.fit_all(human, lm, build=build, start=start, jacobians=jac, verbose=verbose)
    t["fit"] = time.time() - t2

    t3 = time.time()
    scaffold.finish(human, rep)
    if eyes:
        from . import eyes as _eyes
        _eyes.add(human)
    t["rig"] = time.time() - t3

    t4 = time.time()
    hc = measure.run(human.name, preset=s["style"], sex=s["sex"], out_dir=out_dir, build=build)
    t["check"] = time.time() - t4
    thumb = None
    if contact_sheet and out_dir:
        t5 = time.time()
        views.contact_sheet(human.name, out_dir, preset=s["style"], sex=s["sex"], report=hc)
        thumb = f"{out_dir}/body.png"
        t["views"] = time.time() - t5
    card = None
    if store and hc["counts"]["fail"] == 0:
        card = library.save_body(human, r, rep, hc, tags=tags, thumb=thumb)
    t["total"] = time.time() - t0
    return {"human": human.name, "path": path, "nearest": None if not nearest else
            {"id": nearest[1]["id"], "distance": round(nearest[0], 3)},
            "fit": rep, "check": hc["counts"], "stored": card["id"] if card else None, "reuse_check": reuse_check,
            "timing": {k: round(v, 2) for k, v in t.items()}, "guessed": r["guessed"], "notes": r["notes"]}
