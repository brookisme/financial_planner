"""
Main

Lets ``python -m financial_planner ...`` run the CLI (the desktop shortcut uses this).

License: BSD 3-Clause
"""
#
# Imports
#
import sys

from financial_planner.cli import main

#
# PUBLIC
#
if __name__ == '__main__':
    sys.exit(main())
