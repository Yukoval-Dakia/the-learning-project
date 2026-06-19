from __future__ import annotations

import json
import re
import time
from importlib import metadata
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import ImageRefMode


PDF = Path(
    "docling-docx-parse-output/libreoffice-convert/"
    "精品解析：浙江省新昌中学、新昌澄潭中学2025-2026学年高一下学期5月知识技能竞赛数学试卷（原卷版）.pdf"
).resolve()
OUT_DIR = Path(__file__).resolve().parent


def main() -> None:
    options = PdfPipelineOptions()
    options.do_ocr = True
    options.do_table_structure = True
    options.images_scale = 2.0
    options.generate_page_images = True
    options.generate_picture_images = True

    converter = DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
    )

    started = time.perf_counter()
    result = converter.convert(PDF)
    elapsed = time.perf_counter() - started
    doc = result.document

    md_path = OUT_DIR / "xinchang-math-lo-pdf-docling.md"
    ref_md_path = OUT_DIR / "xinchang-math-lo-pdf-docling.with-image-refs.md"
    json_path = OUT_DIR / "xinchang-math-lo-pdf-docling.json"
    summary_path = OUT_DIR / "xinchang-math-lo-pdf-docling.summary.json"

    md_path.write_text(doc.export_to_markdown(), encoding="utf-8")
    doc.save_as_markdown(ref_md_path, image_mode=ImageRefMode.REFERENCED)
    json_path.write_text(json.dumps(doc.export_to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

    md = md_path.read_text(encoding="utf-8")
    non_empty = [line for line in md.splitlines() if line.strip()]
    question_like = [
        line
        for line in non_empty
        if re.match(r"^\s*(\d+)[.．、]", line) or line.startswith(("一、", "二、", "三、", "四、"))
    ]
    summary = {
        "docling_version": metadata.version("docling"),
        "source_pdf": str(PDF),
        "status": str(result.status),
        "elapsed_seconds": round(elapsed, 3),
        "config": {
            "allowed_formats": ["InputFormat.PDF"],
            "PdfPipelineOptions": {
                "do_ocr": options.do_ocr,
                "do_table_structure": options.do_table_structure,
                "images_scale": options.images_scale,
                "generate_page_images": options.generate_page_images,
                "generate_picture_images": options.generate_picture_images,
            },
        },
        "paths": {
            "markdown": str(md_path),
            "markdown_with_refs": str(ref_md_path),
            "json": str(json_path),
        },
        "markdown_chars": len(md),
        "markdown_non_empty_lines": len(non_empty),
        "question_like_lines": len(question_like),
        "first_160_lines": md.splitlines()[:160],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
