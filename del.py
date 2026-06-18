import os
path = r"nul"
try:
    os.remove(path)
    print("Successfully deleted nul file")
except FileNotFoundError:
    print("File not found")
except Exception as e:
    print(f"Error: {e}")
