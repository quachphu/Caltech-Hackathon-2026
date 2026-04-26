#!/usr/bin/env python3
"""Generate a proper OpenShot clip JSON entry using libopenshot."""
import sys, json, uuid
import openshot

video_path = sys.argv[1]
position    = float(sys.argv[2])
layer       = int(sys.argv[3])
file_id     = sys.argv[4]
end_time    = float(sys.argv[5]) if len(sys.argv) > 5 else None

clip = openshot.Clip(video_path)
clip.Position(position)
clip.Layer(layer)

d = json.loads(clip.Json())
d['id']      = str(uuid.uuid4())
d['file_id'] = file_id
d['position'] = position
d['layer']    = layer
d['start']    = 0.0
if end_time is not None:
    d['end']      = end_time
    d['duration'] = end_time

# libopenshot serializes has_video/has_audio with Y=-1 which OpenShot treats as disabled.
# Override to Y=1 (enabled) so the clip renders on the timeline.
_kf_true = {"Points": [{"co": {"X": 1, "Y": 1}, "handle_left": {"X": 0.5, "Y": 1}, "handle_right": {"X": 0.5, "Y": 0}, "handle_type": 0, "interpolation": 0}]}
d['has_video'] = _kf_true
d['has_audio'] = _kf_true

print(json.dumps(d))
