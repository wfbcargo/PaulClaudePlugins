"""L4 part: eyeballs in an MPFB body's sockets.

    eyes = eyes.add("Mara")                 # "Mara_eyes": two spheres, sclera / iris / pupil, on the head bone
    eyes.add("Mara", iris=(0.18, 0.28, 0.35))

MPFB2 hides a 72-vertex proxy ball in each socket (vertex groups `helper-l-eye`, `helper-r-eye`)
behind its "Hide helpers" mask. Its centre and radius, read from the evaluated mesh after every
target and the fit, place a clean sphere exactly where the eyelids expect the eye. The iris faces
the body's forward direction; the pupil is a smaller cap inside it. Materials are plain Principled
BSDF (L6 look development replaces them). The eyes are skinned 100% to the head bone
(`spine.005`), or parented to the body when there is no rig yet.
"""

from __future__ import annotations

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import body as _body

HEAD_BONE = "spine.005"
IRIS_HALF_ANGLE = 32.0     # degrees from the gaze axis: ~11-12 mm across on the ~32 mm MPFB eye proxy
PUPIL_HALF_ANGLE = 14.0


def _helper_points(human, side):
    g = human.vertex_groups.get(f"helper-{side}-eye")
    if g is None:
        raise ValueError(f"{human.name} has no helper-{side}-eye group (not an MPFB2 body?)")
    b = _body.Body(human)
    idx = [v.index for v in human.data.vertices if any(e.group == g.index for e in v.groups)]
    return b.co_unmasked[idx]


def _material(name, colour, rough):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    mat.diffuse_color = (*colour, 1.0)
    return mat


def add(human, iris=(0.25, 0.16, 0.08), segments=32, rings=16):
    human = _body.obj(human)
    rig = _body.rig_of(human)
    name = f"{human.name}_eyes"
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)

    bm = bmesh.new()
    report = {}
    forward = Vector((0, -1, 0))
    for side in ("l", "r"):
        pts = _helper_points(human, side)
        centre = pts.mean(axis=0)
        radius = float(np.linalg.norm(pts - centre, axis=1).mean())
        report[side] = {"centre": [round(float(c), 4) for c in centre], "radius": round(radius, 4)}
        before = set(bm.verts)
        bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=radius,
                                  matrix=Matrix.Translation(Vector(centre)) @ Matrix.Rotation(math.radians(90), 4, "X"))
        new_faces = [f for f in bm.faces if all(v not in before for v in f.verts)]
        for f in new_faces:
            d = (f.calc_center_median() - Vector(centre)).normalized()
            angle = math.degrees(d.angle(forward))
            f.material_index = 2 if angle < PUPIL_HALF_ANGLE else 1 if angle < IRIS_HALF_ANGLE else 0
            f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for mat in (_material("HF_sclera", (0.86, 0.84, 0.8), 0.25), _material(f"HF_iris_{name}", iris, 0.35),
                _material("HF_pupil", (0.01, 0.01, 0.01), 0.2)):
        me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    for coll in human.users_collection:
        coll.objects.link(ob)
    if rig is not None and HEAD_BONE in rig.data.bones:
        ob.parent = rig
        vg = ob.vertex_groups.new(name=HEAD_BONE)
        vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
        mod = ob.modifiers.new("Armature", "ARMATURE")
        mod.object = rig
    else:
        ob.parent = human
    report["object"] = name
    return ob, report
