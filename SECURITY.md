# Security

## Supported versions

Only the latest release gets fixes – the Windows app from
[Releases](https://github.com/Aleshek/Scamcrobat/releases/latest) and the
[web version](https://aleshek.github.io/Scamcrobat/), which is always the latest.
The desktop app tells you when a newer version is out.

## Reporting a vulnerability

Please do not report security problems in a public issue. Use
**[Report a vulnerability](https://github.com/Aleshek/Scamcrobat/security/advisories/new)**
(the Security tab of this repository) instead – only the maintainers see the report.
You can write in English or Czech.

Helpful to include: the version, desktop app or web (and which browser), what an attacker
can do, and steps or a file that show it. If the problem needs a PDF, make one that contains
nothing private.

Scamcrobat is maintained in spare time, so there is no fixed response time, but security
reports come first. Once a fix is released, the report is published with credit to you,
unless you prefer otherwise.

## What counts

For example:

- a PDF or image that runs code, reads or writes files other than the one opened or saved,
  or gets out of the app's sandbox
- content that stays in a saved file after a redaction (black-out) or after it was deleted
- password protection that is weaker than described, or a password that ends up stored
  or sent anywhere
- the app sending anything about you or your documents over the network (the only request
  it makes on its own is the daily check of the latest version number on GitHub, which can
  be turned off on the start page)

Bugs in [MuPDF](https://mupdf.com/), the PDF library Scamcrobat uses, are best reported to
its authors as well; Scamcrobat then updates to the fixed version.
