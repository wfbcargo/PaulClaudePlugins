"""L0: a character sheet - the brief as data - and the full set of body measurements it implies.

    s = sheet.new(name="Mara", sex="female", age=34, stature=1.72, build="athletic", style="realistic")
    r = sheet.resolve(s)            # every ANSUR II variable, in metres, consistent with the brief
    r["values"]["crotchheight"], r["guessed"], r["notes"]

A body is drawn from ANSUR II as a multivariate normal per sex: whatever the brief fixes
(stature, weight or BMI, age, any measurement, a build's leanings) is conditioned on, and every
other measurement takes its conditional mean - or, with a seed, a draw from its conditional
distribution scaled by `variation`, so bodies differ the way people do: a tall woman gets the
crotch height, arm length and hip breadth tall women have, not a scaled-up average.
"""

from __future__ import annotations

import copy
import json
import os
import sys

import numpy as np

_pkg = sys.modules[__package__]
SCHEMA = "humanform-sheet/1"

# Build words -> what they fix: a BMI, and z-scores (in conditional sd) for measurements.
BUILDS = {
    "slim":      {"bmi": 20.5, "z": {"waistcircumference": -0.6, "buttockcircumference": -0.4}},
    "average":   {"bmi": None, "z": {}},
    "athletic":  {"bmi": 24.0, "z": {"waistcircumference": -1.0, "bideltoidbreadth": 0.8,
                                     "bicepscircumferenceflexed": 0.8, "thighcircumference": 0.3}},
    "muscular":  {"bmi": 27.5, "z": {"waistcircumference": -0.8, "bideltoidbreadth": 1.4, "chestcircumference": 1.0,
                                     "bicepscircumferenceflexed": 1.6, "neckcircumference": 1.0}},
    "curvy":     {"bmi": 25.5, "z": {"waistcircumference": -0.8, "buttockcircumference": 1.2, "hipbreadth": 1.0,
                                     "thighcircumference": 0.8}},
    "soft":      {"bmi": 27.0, "z": {"bicepscircumferenceflexed": -0.5, "waistcircumference": 0.5}},
    "heavy":     {"bmi": 31.0, "z": {"waistcircumference": 0.8}},
}
STYLES = ("realistic", "stylized")
AGE_RANGE = (17.0, 58.0)      # ANSUR II subjects


def _data():
    with open(os.path.join(_pkg.DATA, "anthropometry.json"), encoding="utf-8") as fh:
        return json.load(fh)


_CACHE = {}


def anthropometry():
    if "doc" not in _CACHE:
        _CACHE["doc"] = _data()
    return _CACHE["doc"]


def new(name="Human", sex="female", age=None, stature=None, weight=None, bmi=None, build="average",
        style="realistic", measurements=None, seed=None, variation=0.5, budget_tris=30000, notes=""):
    """A sheet. Leave anything unknown as None; resolve() fills it and marks it guessed."""
    return {"schema": SCHEMA, "name": name, "sex": sex, "age": age, "stature": stature, "weight": weight,
            "bmi": bmi, "build": build, "style": style, "measurements": dict(measurements or {}),
            "seed": seed, "variation": variation, "budget_tris": budget_tris, "notes": notes}


def validate(s):
    """A list of problems; empty when the sheet can be resolved."""
    p = []
    if s.get("schema") != SCHEMA:
        p.append(f"schema must be {SCHEMA}")
    if s.get("sex") not in ("female", "male"):
        p.append("sex must be 'female' or 'male' (the measurement data is per sex)")
    if s.get("style") not in STYLES:
        p.append(f"style must be one of {STYLES}")
    b = s.get("build")
    if isinstance(b, str) and b not in BUILDS:
        p.append(f"build {b!r} is not one of {sorted(BUILDS)} (or pass a dict with bmi and z)")
    st = s.get("stature")
    if st is not None and not 1.3 <= st <= 2.2:
        p.append(f"stature {st} m is outside 1.3-2.2 m (is it in metres?)")
    names = set(anthropometry()["variables"])
    for k in s.get("measurements", {}):
        if k not in names:
            p.append(f"measurement {k!r} is not an ANSUR II variable")
    return p


def _condition(mu, cov, idx, values):
    """Gaussian conditioning: mean and covariance of the rest given x[idx] = values."""
    n = len(mu)
    rest = np.array([i for i in range(n) if i not in set(idx)], dtype=int)
    if not len(idx):
        return rest, mu[rest], cov[np.ix_(rest, rest)]
    idx = np.array(idx, dtype=int)
    soo = cov[np.ix_(idx, idx)]
    sro = cov[np.ix_(rest, idx)]
    k = sro @ np.linalg.pinv(soo)
    m = mu[rest] + k @ (np.asarray(values) - mu[idx])
    c = cov[np.ix_(rest, rest)] - k @ sro.T
    return rest, m, c


def resolve(s):
    """Fill every ANSUR variable for the sheet. Returns {sheet, values, guessed, notes, z}."""
    problems = validate(s)
    if problems:
        raise ValueError("; ".join(problems))
    doc = anthropometry()
    names = doc["variables"]
    sx = doc["sexes"][s["sex"]]
    mu = np.array([sx["variables"][v]["mean"] for v in names])
    cov = np.array(sx["covariance"])
    ix = {v: i for i, v in enumerate(names)}
    out = copy.deepcopy(s)
    guessed, notes = [], []

    fixed = {}
    if s.get("age") is not None:
        a = float(np.clip(s["age"], *AGE_RANGE))
        if a != s["age"]:
            notes.append(f"age {s['age']} is outside the measured range {AGE_RANGE}; proportions use {a:g}. "
                         "Ageing beyond it (sagging tissue, stoop, thinner limbs) is not modelled here.")
        fixed["Age"] = a
    if s.get("stature") is not None:
        fixed["stature"] = float(s["stature"])
    for k, v in s.get("measurements", {}).items():
        fixed[k] = float(v)

    build = s.get("build") or "average"
    spec = BUILDS[build] if isinstance(build, str) else build
    bmi = s.get("bmi") if s.get("bmi") is not None else spec.get("bmi")
    if s.get("weight") is not None:
        fixed["weightkg"] = float(s["weight"])
    elif bmi is not None:
        if "stature" not in fixed:
            fixed["stature"] = float(mu[ix["stature"]])
            guessed.append("stature")
        fixed["weightkg"] = bmi * fixed["stature"] ** 2

    idx = [ix[k] for k in fixed]
    rest, m, c = _condition(mu, cov, idx, [fixed[k] for k in fixed])

    # a build's leanings: set each named measurement z conditional sd from its conditional mean, in turn
    for var, z in spec.get("z", {}).items():
        if var in fixed or var not in ix:
            continue
        j = int(np.flatnonzero(rest == ix[var])[0])
        fixed[var] = float(m[j] + z * np.sqrt(max(c[j, j], 0.0)))
        idx = [ix[k] for k in fixed]
        rest, m, c = _condition(mu, cov, idx, [fixed[k] for k in fixed])

    if s.get("seed") is not None:
        # one correlated draw from what is left free, each measurement kept within 2 sd, scaled down
        rng = np.random.default_rng(int(s["seed"]))
        c_sym = (c + c.T) / 2
        w, vec = np.linalg.eigh(c_sym)
        draw = vec @ (np.sqrt(np.clip(w, 0, None)) * rng.standard_normal(len(w)))
        sd = np.sqrt(np.clip(np.diag(c_sym), 0, None))
        m = m + float(s.get("variation", 0.5)) * np.clip(draw, -2 * sd, 2 * sd)

    values = dict(fixed)
    for j, i in enumerate(rest):
        values[names[i]] = float(m[j])
    for k in ("age", "stature", "weight"):
        if s.get(k) is None and k not in guessed:
            guessed.append(k)

    z = {}
    for v in names:
        sd = sx["variables"][v]["sd"]
        z[v] = round((values[v] - sx["variables"][v]["mean"]) / sd, 2) if sd > 0 else 0.0
    out["age"] = round(values["Age"], 1)
    out["stature"] = round(values["stature"], 4)
    out["weight"] = round(values["weightkg"], 1)
    out["bmi"] = round(values["weightkg"] / values["stature"] ** 2, 1)
    out["guessed"] = guessed
    extreme = [f"{v} ({z[v]:+.1f} sd)" for v in names if abs(z[v]) > 2.5 and v not in fixed]
    if extreme:
        notes.append("beyond 2.5 sd of the measured population: " + ", ".join(extreme))
    return {"sheet": out, "values": values, "z": z, "guessed": guessed, "notes": notes}


def save(s, path):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(s, fh, indent=1)


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
