# YUK-967 — optional knowledge observations

The original presentation-tool actual invented absence of recent failures after
requesting only children. Knowledge owns whether a section was observed; neither
Copilot prose nor a second evaluator should infer it from an absent property.

Plan:
1. Add explicit not_requested / no_returned_nodes / observed section status at
   the existing reader contract, plus the bounded failure scope.
2. Verify omitted, empty, nonempty and unmatched-node reads against real DB rows;
   verify the same contract survives the public result snapshot.
3. Run the unchanged presentation-tool actual from a clean integrated revision,
   reserving before any paid call. Current pool safe0.44177; no call reserved yet.
4. Independent review, local scoped gates and exact-head CI before merge.

No extra query/model call, reply rewriting, new evaluator or UI change. Existing
failure snippets are latest10 across recorded attempts; stats counts remain30d.
Do not silently turn either into the other or claim global absence from no nodes.
