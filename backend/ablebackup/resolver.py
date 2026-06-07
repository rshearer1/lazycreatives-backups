from pathlib import Path

from ablebackup.models import FileRef, ResolvedRef


def _candidates(ref: FileRef, project_dir: Path) -> list[Path]:
    out: list[Path] = []
    if ref.absolute_path:
        out.append(Path(ref.absolute_path))
    if ref.relative_path:
        out.append(project_dir / Path(ref.relative_path.replace("\\", "/")))
    return out


def _is_inside(path: Path, project_dir: Path) -> bool:
    try:
        path.resolve().relative_to(project_dir.resolve())
        return True
    except ValueError:
        return False


def resolve_refs(refs: list[FileRef], project_dir: Path) -> list[ResolvedRef]:
    resolved: list[ResolvedRef] = []
    # A sample used by N clips appears as N identical FileRefs; collapse them so
    # counts and sizes reflect unique files, not how many times each is triggered.
    seen: set[str] = set()
    for ref in refs:
        chosen: Path | None = None
        for cand in _candidates(ref, project_dir):
            # Only real files are backable. A reference can resolve to a directory
            # (e.g. an Ableton built-in device bundle like Simpler inside the .app);
            # those are not user samples and must not be hashed/copied as files.
            if cand.is_file():
                chosen = cand
                break
        if chosen is not None:
            key = str(chosen.resolve())
            if key in seen:
                continue
            seen.add(key)
            resolved.append(ResolvedRef(
                name=ref.name or chosen.name,
                resolved_path=chosen,
                exists=True,
                inside_project=_is_inside(chosen, project_dir),
                size=chosen.stat().st_size,
            ))
        else:
            expected = ref.relative_path or ref.absolute_path or ref.name
            if f"missing::{expected}" in seen:
                continue
            seen.add(f"missing::{expected}")
            resolved.append(ResolvedRef(
                name=ref.name,
                resolved_path=None,
                exists=False,
                inside_project=False,
                size=0,
                expected_path=expected,
            ))
    return resolved
