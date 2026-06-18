"""Smoke test for the automated PR review pipeline (OCR + PR-Agent / GLM-5.2).

This file exists only to trigger both reviewers on the same diff so their
output can be compared. It is not part of the project — close the PR without
merging.
"""


def average(numbers):
    # NOTE: deliberately missing an empty-input guard, so the reviewers have a
    # real bug to flag — calling average([]) raises ZeroDivisionError.
    return sum(numbers) / len(numbers)


if __name__ == "__main__":
    print(average([1, 2, 3]))
    print(average([]))  # will crash — reviewers should catch this
