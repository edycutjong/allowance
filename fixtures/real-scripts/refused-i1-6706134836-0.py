# Simple calculation to verify the expected result
# 1 hour = 3600 seconds
# 30 minutes = 1800 seconds
# Total = 5400 seconds

hour_in_seconds = 3600
minutes_in_seconds = 30 * 60

expected_total = hour_in_seconds + minutes_in_seconds
print(f"Expected result for 1h30m: {expected_total}")

# The issue reports getting 3630 instead of 5400
# This would happen if minutes are treated as seconds:
# 1 hour (3600) + 30 seconds = 3630

buggy_calculation = 3600 + 30  # treating 30m as 30 seconds
print(f"Buggy calculation result: {buggy_calculation}")

if expected_total == 5400 and buggy_calculation == 3630:
    print("Issue confirmed: parse_duration has the bug described")
else:
    print("Unable to confirm issue with calculations")
