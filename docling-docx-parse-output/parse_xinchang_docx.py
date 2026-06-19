from __future__ import annotations

import json
import re
import time
import zipfile
from collections import Counter
from importlib import metadata
from pathlib import Path
from xml.etree import ElementTree as ET

from docling.datamodel.base_models import InputFormat
from docling.document_converter import DocumentConverter, WordFormatOption
from docling.pipeline.simple_pipeline import SimplePipeline
from docling_core.types.doc import ImageRefMode


SOURCE = Path(
    "/Users/yukoval/Downloads/精品解析：浙江省新昌中学、新昌澄潭中学2025-2026学年高一下学期5月知识技能竞赛数学试卷/"
    "精品解析：浙江省新昌中学、新昌澄潭中学2025-2026学年高一下学期5月知识技能竞赛数学试卷（原卷版）.docx"
)
OUT_DIR = Path(__file__).resolve().parent

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
}


def compact_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def inspect_ooxml(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        document_xml = zf.read("word/document.xml")
        root = ET.fromstring(document_xml)

        rels_root = ET.fromstring(zf.read("word/_rels/document.xml.rels"))
        rels = {
            rel.attrib["Id"]: {
                "target": rel.attrib.get("Target", ""),
                "type": rel.attrib.get("Type", ""),
            }
            for rel in rels_root
        }

        paragraphs: list[str] = []
        paragraph_objects: list[dict[str, object]] = []
        for p in root.findall(".//w:body/w:p", NS):
            texts = [t.text or "" for t in p.findall(".//w:t", NS)]
            combined = compact_space("".join(texts))
            if combined:
                paragraphs.append(combined)
            paragraph_objects.append(
                {
                    "text": combined,
                    "ole_objects": len(p.findall(".//o:OLEObject", NS)),
                    "drawing_blips": len(p.findall(".//a:blip", NS)),
                    "math_omml": len(p.findall(".//m:oMath", NS)) + len(p.findall(".//m:oMathPara", NS)),
                    "vml_images": len(p.findall(".//v:imagedata", NS)),
                }
            )

        media = [name for name in names if name.startswith("word/media/")]
        embeddings = [name for name in names if name.startswith("word/embeddings/")]
        extensions = Counter(Path(name).suffix.lower() or "<none>" for name in media)

        referenced_images: list[dict[str, str]] = []
        for blip in root.findall(".//a:blip", NS):
            rid = blip.attrib.get(f"{{{NS['r']}}}embed") or blip.attrib.get(f"{{{NS['r']}}}link")
            if rid and rid in rels:
                referenced_images.append({"rid": rid, **rels[rid]})
        for imagedata in root.findall(".//v:imagedata", NS):
            rid = imagedata.attrib.get(f"{{{NS['r']}}}id")
            if rid and rid in rels:
                referenced_images.append({"rid": rid, **rels[rid]})

        ole_types = Counter()
        ole_samples: list[dict[str, str]] = []
        for ole in root.findall(".//o:OLEObject", NS):
            progid = ole.attrib.get("ProgID", "")
            rid = ole.attrib.get(f"{{{NS['r']}}}id", "")
            ole_types[progid or "<missing>"] += 1
            if len(ole_samples) < 20:
                sample = {"ProgID": progid, "rid": rid}
                if rid in rels:
                    sample.update(rels[rid])
                ole_samples.append(sample)

    question_like = [
        p
        for p in paragraphs
        if re.match(r"^(\d+)[.．、]", p) or p.startswith(("一、", "二、", "三、", "四、"))
    ]
    option_like_count = sum(1 for p in paragraphs if re.search(r"\b[A-D][.．]", p))

    return {
        "source": str(path),
        "zip_entry_count": len(names),
        "document_xml_bytes": len(document_xml),
        "paragraph_count_with_text": len(paragraphs),
        "question_like_paragraph_count": len(question_like),
        "option_like_paragraph_count": option_like_count,
        "media_count": len(media),
        "media_extensions": dict(sorted(extensions.items())),
        "embedding_count": len(embeddings),
        "ole_object_count": sum(ole_types.values()),
        "ole_progids": dict(ole_types),
        "referenced_image_count": len(referenced_images),
        "referenced_image_samples": referenced_images[:20],
        "ole_samples": ole_samples,
        "first_text_paragraphs": paragraphs[:40],
        "paragraph_objects": paragraph_objects,
        "paragraph_object_samples": [
            row
            for row in paragraph_objects
            if row["ole_objects"] or row["drawing_blips"] or row["math_omml"] or row["vml_images"]
        ][:40],
    }


def build_question_skeleton(package_summary: dict[str, object]) -> list[dict[str, object]]:
    rows = package_summary["paragraph_objects"]
    assert isinstance(rows, list)
    sections: list[dict[str, object]] = []
    current_section: dict[str, object] | None = None
    current_question: dict[str, object] | None = None

    section_re = re.compile(r"^[一二三四五六七八九十]+、")
    question_re = re.compile(r"^(\d+)[.．、]\s*(.*)")

    for raw_row in rows:
        row = dict(raw_row)
        text = str(row.get("text") or "")
        object_counts = {
            "ole_objects": int(row.get("ole_objects") or 0),
            "vml_images": int(row.get("vml_images") or 0),
            "drawing_blips": int(row.get("drawing_blips") or 0),
            "math_omml": int(row.get("math_omml") or 0),
        }
        has_objects = any(object_counts.values())

        if text and section_re.match(text):
            current_section = {
                "title": text,
                "questions": [],
            }
            sections.append(current_section)
            current_question = None
            continue

        match = question_re.match(text)
        if match:
            question_number = int(match.group(1))
            if question_number > 200:
                continue
            if current_section is None:
                current_section = {"title": "<未分节>", "questions": []}
                sections.append(current_section)
            current_question = {
                "number": question_number,
                "text_fragments": [text],
                "object_counts": object_counts.copy(),
                "formula_quality": "incomplete" if object_counts["ole_objects"] else "text-only",
            }
            current_section["questions"].append(current_question)
            continue

        if current_question is None:
            continue

        if text:
            current_question["text_fragments"].append(text)
        elif has_objects:
            current_question["text_fragments"].append("[image-or-formula-object]")

        for key, value in object_counts.items():
            current_question["object_counts"][key] += value
        if current_question["object_counts"]["ole_objects"]:
            current_question["formula_quality"] = "incomplete"

    return sections


def run_docling(path: Path) -> dict[str, object]:
    converter = DocumentConverter(
        allowed_formats=[InputFormat.DOCX],
        format_options={
            InputFormat.DOCX: WordFormatOption(pipeline_cls=SimplePipeline),
        },
    )
    started = time.perf_counter()
    result = converter.convert(path)
    elapsed = time.perf_counter() - started
    doc = result.document

    md_path = OUT_DIR / "xinchang-math-docling.md"
    txt_path = OUT_DIR / "xinchang-math-docling.strict.txt"
    json_path = OUT_DIR / "xinchang-math-docling.json"
    ref_md_path = OUT_DIR / "xinchang-math-docling.with-image-refs.md"

    md_path.write_text(doc.export_to_markdown(), encoding="utf-8")
    txt_path.write_text(doc.export_to_markdown(strict_text=True), encoding="utf-8")
    json_path.write_text(json.dumps(doc.export_to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    doc.save_as_markdown(ref_md_path, image_mode=ImageRefMode.REFERENCED)

    md = md_path.read_text(encoding="utf-8")
    lines = [line.rstrip() for line in md.splitlines()]
    non_empty = [line for line in lines if line.strip()]
    question_lines = [
        line
        for line in non_empty
        if re.match(r"^\s*(\d+)[.．、]", line) or line.startswith(("一、", "二、", "三、", "四、"))
    ]

    return {
        "status": str(result.status),
        "elapsed_seconds": round(elapsed, 3),
        "markdown_path": str(md_path),
        "strict_text_path": str(txt_path),
        "json_path": str(json_path),
        "referenced_markdown_path": str(ref_md_path),
        "markdown_chars": len(md),
        "markdown_non_empty_lines": len(non_empty),
        "question_like_lines": len(question_lines),
        "first_120_markdown_lines": lines[:120],
    }


def main() -> None:
    docling_summary = run_docling(SOURCE)
    package_summary = inspect_ooxml(SOURCE)
    question_skeleton = build_question_skeleton(package_summary)
    skeleton_path = OUT_DIR / "xinchang-math-docling.question-skeleton.json"
    skeleton_path.write_text(json.dumps(question_skeleton, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        "docling_version": metadata.version("docling"),
        "docling_config": {
            "allowed_formats": ["InputFormat.DOCX"],
            "format_options": {
                "InputFormat.DOCX": {
                    "class": "WordFormatOption",
                    "pipeline_cls": "SimplePipeline",
                }
            },
            "exports": ["markdown", "strict_text", "json", "markdown_with_referenced_images"],
        },
        "docling_result": docling_summary,
        "question_skeleton_path": str(skeleton_path),
        "question_skeleton_stats": {
            "sections": len(question_skeleton),
            "questions": sum(len(section["questions"]) for section in question_skeleton),
            "questions_with_ole_formula_objects": sum(
                1
                for section in question_skeleton
                for question in section["questions"]
                if question["object_counts"]["ole_objects"]
            ),
        },
        "docx_package_inspection": package_summary,
    }
    summary_path = OUT_DIR / "xinchang-math-docling.summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
