"""Entry point: python -m mapper or the mapper command."""

import sys


def main() -> None:
    from .ui.app import run

    sys.exit(run())


if __name__ == "__main__":
    main()
