REVIEW CHECKS

These are questions to ask of every change. A check tells you where to look. It is not a finding.
Report a finding from a check only when you can name the concrete input, state or reader that breaks, with a file and a line. If you cannot, report nothing.
When a finding comes from a check, start its body with the check id in brackets, for example [C3].

C1 One source of truth. The change moves a kind of value into one place, such as a table, a config file or a constant. Look for other definitions of that kind of value outside the changed lines. One that the central place does not cover is a finding.

C2 Odd sibling. The change declares several siblings with the same role, such as services, props, branches or handlers, and one is declared differently. Say what the odd one loses or gains. A lost behavior that the others keep is a finding.

C3 New writer. The change starts filling a field that was empty or fixed, or adds a new way to create a value. Follow the readers of that field or value in unchanged code. A reader that now gets a value it did not expect is a finding.

C4 Old copies. The change adds an entry to a source that a generated and kept file is built from, such as a per-user settings file. Ask what a copy built before this change does. A fallback that breaks a rule the generator keeps is a finding.

C5 Retry on a conflict. The change adds a retry or a restart to get past a conflict. Name what frees the contested resource and check that it happens within the retries. A resource that is never freed is a finding.

C6 Stale statement. The change alters behavior or configuration that documentation describes. Look for statements about it in the docs, starting with files the change already touches. A statement that is now false is a finding.

C7 Outside the goal. The change edits modules only to move or reshape code, and its description does not mention that. Report it once, as P3.
