import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/edycutjong/allowance-demo"], check=True)
from pocketkit.lists import chunk
actual = list(chunk([1, 2, 3, 4, 5], 2))
expected = [[1, 2], [3, 4], [5]]
if actual != expected:
    raise AssertionError("REPRODUCED: expected " + repr(expected) + ", got " + repr(actual))
print("NOT REPRODUCED")
