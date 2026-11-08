import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/edycutjong/allowance-demo@9259e59b6a72a243c91ea420df20788ef2b3c72a"], check=True)
from pocketkit.lists import chunk
actual = list(chunk([1, 2, 3, 4, 5], 2))
expected = [[1, 2], [3, 4], [5]]
if actual != expected:
    raise AssertionError("REPRODUCED: expected " + repr(expected) + ", got " + repr(actual))
print("NOT REPRODUCED")
