import platform
import sys


def greet(name: str) -> str:
    return f"Hello {name} from Python {platform.python_version()} ({platform.machine()})"


if __name__ == "__main__":
    print(greet("Web-IDE"))
    print("executable", sys.executable)
