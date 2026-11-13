"""Generates a test PDF with form fields, links and a rotated page.

Usage: python scripts/make-form-pdf.py  ->  test/fixtures/form.pdf
"""
from pathlib import Path

import pymupdf as fitz

OUT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "form.pdf"


def widget(page, kind, name, rect, **kw):
    w = fitz.Widget()
    w.field_type = kind
    w.field_name = name
    w.rect = fitz.Rect(rect)
    w.text_fontsize = kw.pop("fontsize", 11)
    w.border_color = (0.55, 0.6, 0.7)
    w.border_width = 0.8
    for k, v in kw.items():
        setattr(w, k, v)
    page.add_widget(w)
    return w


def main():
    doc = fitz.open()

    # Page 1: a small order form.
    p = doc.new_page(width=595, height=842)
    p.insert_text((56, 70), "Field trip registration", fontsize=22, fontname="helv")
    p.insert_text((56, 92), "Corvid Watchers Club – please fill in and sign.", fontsize=11, color=(0.35, 0.35, 0.4))

    y = 130
    p.insert_text((56, y + 14), "Full name", fontsize=11)
    widget(p, fitz.PDF_WIDGET_TYPE_TEXT, "name", (170, y, 520, y + 22))
    y += 40
    p.insert_text((56, y + 14), "E-mail", fontsize=11)
    widget(p, fitz.PDF_WIDGET_TYPE_TEXT, "email", (170, y, 520, y + 22))
    y += 40
    p.insert_text((56, y + 14), "Group size", fontsize=11)
    widget(p, fitz.PDF_WIDGET_TYPE_COMBOBOX, "group", (170, y, 300, y + 22),
           choice_values=["1", "2", "3", "4", "5+"], field_value="1")
    y += 40
    p.insert_text((56, y + 14), "Trips", fontsize=11)
    for i, label in enumerate(["Morning", "Afternoon", "Evening"]):
        x = 170 + i * 110
        widget(p, fitz.PDF_WIDGET_TYPE_CHECKBOX, label.lower(), (x, y + 3, x + 16, y + 19),
               field_value=(i == 0))
        p.insert_text((x + 22, y + 15), label, fontsize=11)
    y += 40
    widget(p, fitz.PDF_WIDGET_TYPE_CHECKBOX, "binoculars", (56, y + 3, 72, y + 19), field_value=False)
    p.insert_text((80, y + 15), "I need to borrow binoculars", fontsize=11)
    y += 40
    p.insert_text((56, y + 14), "Notes", fontsize=11)
    widget(p, fitz.PDF_WIDGET_TYPE_TEXT, "notes", (170, y, 520, y + 80),
           field_flags=fitz.PDF_TX_FIELD_IS_MULTILINE)
    y += 110
    p.insert_text((56, y + 14), "Signature", fontsize=11)
    p.draw_line((170, y + 40), (400, y + 40), color=(0.4, 0.4, 0.45), width=0.8)

    y += 90
    sentence = "Read the club rules on page 2 or at the club website."
    p.insert_text((56, y), sentence, fontsize=11)
    link_y = y

    # Page 2: rules, rotated by 90° to test coordinates.
    p2 = doc.new_page(width=595, height=842)
    p2.insert_text((56, 70), "Club rules", fontsize=22, fontname="helv")
    rules = [
        "1. Keep a respectful distance from nests.",
        "2. Never feed the birds bread.",
        "3. Write down every sighting with the time and place.",
        "4. Crows remember faces – be kind.",
    ]
    for i, line in enumerate(rules):
        p2.insert_text((56, 110 + i * 22), line, fontsize=12)
    p2.set_rotation(90)

    # Internal link to page 2 and an external link, over the words of the sentence.
    def span(words):
        x = 56 + fitz.get_text_length(sentence[: sentence.index(words)], fontsize=11)
        return fitz.Rect(x, link_y - 10, x + fitz.get_text_length(words, fontsize=11), link_y + 3)

    p = doc[0]  # adding a page invalidates the old page object
    p.insert_link({"kind": fitz.LINK_GOTO, "from": span("page 2"), "page": 1})
    p.insert_link({"kind": fitz.LINK_URI, "from": span("the club website"), "uri": "https://example.com/"})

    doc.set_metadata({"title": "Field trip registration"})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT, garbage=3, deflate=True)
    print(OUT)


if __name__ == "__main__":
    main()
