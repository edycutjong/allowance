import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/edycutjong/allowance-demo"], check=True)
from datetime import date
from pocketkit import business_days_between
actual = business_days_between(date(2026, 11, 2), date(2026, 11, 6))
if actual != 5:
    raise AssertionError("REPRODUCED: expected 5, got " + repr(actual))
print("NOT REPRODUCED")
