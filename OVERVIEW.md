# Paseo Fold Turns

Completed tool calls, thinking, progress messages and context compaction collapse
into one expandable line above the final answer. Expand the line to inspect the
process. The final answer keeps Paseo's normal formatting and answer controls.
Running turns, pending questions and permissions, errors, ambiguous entries and
incomplete history remain visible.

Requires Paseo 0.11.2 or later within the 0.11 release series, on both the daemon
and app. Plugins must be enabled. No provider accounts or credentials are needed.
Use one timeline-folding plugin at a time. The Process composer button expands or
collapses completed turns in the open chat.

Desktop and web reuse Paseo's timeline rows. Native clients expand one persistent
inline block, with selectable Markdown, tool details, code copying and pagination.
Position preservation depends on the supported Paseo and React Native view
structure. Compatibility needs review before adopting later Paseo minor versions.

The daemon reads the viewed agent's timeline and sends grouping metadata to the
app. Expanding a native block also sends that turn's intermediate text and tool
details to the connected client. Loaded pages stay in client memory. The plugin
creates no disk archive and sends no data to models or external services. Links
open only when clicked; images are links rather than automatic downloads.

The index covers at most 8,000 projected entries. Native pages contain up to 40
entries, with a visible truncation notice for text fields exceeding 16,000
characters. Provider subagent views without daemon records keep Paseo's default
presentation.
