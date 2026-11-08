import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/edycutjong/allowance-demo@9259e59b6a72a243c91ea420df20788ef2b3c72a"], check=True)
from datetime import date
from allowance import business_days

# Test the specific case mentioned in the issue
start_date = date(2026, 11, 2)  # Monday
end_date = date(2026, 11, 9)    # Next Monday

actual = business_days(start_date, end_date)
expected = 5  # Based on the issue description, this is what's being returned

# But according to the user, it should be 4 (Monday to Friday, exclusive end)
# Let's verify what the correct count should be:
# Nov 2, 2026 (Monday) to Nov 9, 2026 (Monday) exclusive should be:
# Nov 2 (Mon), Nov 3 (Tue), Nov 4 (Wed), Nov 5 (Thu), Nov 6 (Fri) = 5 business days
# But if end is exclusive, it should be Nov 2-6 = 5 days, which matches

# Wait, let me re-read the issue. The user says "Monday to the next Monday should be 5 working days if the end is exclusive"
# But they're getting 5 and saying that's wrong? That's confusing.

# Let me check what the README example says - they mention getting 4 for Monday to Friday
# So for Mon to Fri (exclusive end), it should be 4 days: Mon, Tue, Wed, Thu

# Let me test a clearer case first to understand the expected behavior
monday_to_friday = business_days(date(2026, 11, 2), date(2026, 11, 6))  # Mon to Fri (exclusive)

# Now test the problematic case
monday_to_next_monday = business_days(date(2026, 11, 2), date(2026, 11, 9))  # Mon to next Mon (exclusive)

# According to the issue, Monday to Friday should be 4 days
# Monday to next Monday (exclusive) should be 5 days (Mon-Fri)
# If the function returns 5 for Mon-Mon (exclusive), that seems correct

# But the user is reporting it as a bug, so maybe there's something else

# Let me just test what they're actually reporting
if monday_to_next_monday != 5:
    raise AssertionError("REPRODUCED: expected 5, got " + repr(monday_to_next_monday))

print("NOT REPRODUCED")
