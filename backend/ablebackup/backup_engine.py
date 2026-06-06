import os
from pathlib import Path


def supports_hardlinks(dest_dir: Path) -> bool:
    """Probe whether the destination filesystem supports hardlinks."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    src = dest_dir / ".hardlink_probe_src"
    dst = dest_dir / ".hardlink_probe_dst"
    try:
        src.write_bytes(b"probe")
        os.link(src, dst)
        return True
    except (OSError, NotImplementedError):
        return False
    finally:
        for p in (dst, src):
            try:
                p.unlink()
            except OSError:
                pass
