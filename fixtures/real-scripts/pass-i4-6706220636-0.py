import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/edycutjong/allowance-demo"], check=True)
from pocketkit.lists import dedupe
actual = dedupe([3, 1, 3, 2, 1])
expected = [3, 1, 2]
if actual != expected:
    raise AssertionError("REPRODUCED: expected " + repr(expected) + ", got " + repr(actual))
print("NOT REPRODUCED")
