import type { Json } from "../types.ts";

export const MERMAID_TYPES = [
  "flowchart",
  "swimlane-beta",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "requirementDiagram",
  "usecase-beta",
  "C4Context",
  "zenuml",
  "packet",
  "architecture-beta",
  "eventmodeling",
  "treeView-beta",
] as const;

export type MermaidType = typeof MERMAID_TYPES[number];

const DOCS: Record<MermaidType, string> = {
  "flowchart": `# flowchart
Use for decisions, branches, pipelines, and fallback paths.
Syntax: flowchart LR
  A[Input] --> B{Check}
  B -->|yes| C[Done]
Use short ids and labels. Directions: TB, TD, BT, LR, RL. Use [] for tasks,
{} for decisions, and --> for arrows. Optional frontmatter config can set
flowchart, theme, and themeVariables values documented by Mermaid.`,
  "swimlane-beta": `# swimlane-beta
Use when work crosses owners, actors, services, teams, or layers.
Syntax:
swimlane-beta LR
  subgraph Intake
    request[Request]
  end
  subgraph Worker
    process[Process]
  end
  request --> process
Top-level subgraph blocks are lanes. Nodes use flowchart shapes. Directions:
TB, TD, BT, LR, RL. Label cross-lane handoffs. Optional frontmatter config
may set swimlane and themeVariables values documented by Mermaid.`,
  "sequenceDiagram": `# sequenceDiagram
Use for ordered messages, webhooks, retries, responses, and timing.
Syntax:
sequenceDiagram
  participant Client
  participant API
  Client->>API: request
  API-->>Client: response
Use participant, actor, alt, opt, loop, par, and critical only when supported
by the evidence. Use ->> for calls and -->> for replies. Optional frontmatter
config may set sequence and themeVariables values documented by Mermaid.`,
  "classDiagram": `# classDiagram
Use for class, interface, type, inheritance, and composition relationships.
Syntax:
classDiagram
  class Review {
    +status: string
    +post()
  }
  Review --> Finding : contains
Use class blocks for members and -->, <|--, *--, or o-- for relationships.
Do not invent members. Optional frontmatter config may set class and themeVariables
values documented by Mermaid.`,
  "stateDiagram-v2": `# stateDiagram-v2
Use for a lifecycle and its state transitions.
Syntax:
stateDiagram-v2
  [*] --> Pending
  Pending --> Running : start
  Running --> Done : finish
  Done --> [*]
Use [*] for start/end, --> for transitions, and labels after :. Composite
states use state Name { ... }. Optional frontmatter config may set state and
themeVariables values documented by Mermaid.`,
  "erDiagram": `# erDiagram
Use for database entities, keys, and cardinality.
Syntax:
erDiagram
  REVIEW ||--o{ FINDING : contains
  REVIEW {
    string id PK
  }
  FINDING {
    string review_id FK
  }
Use ||, o|, ||, }|, and related cardinality markers only when supported.
Optional frontmatter config may set er and themeVariables values documented
by Mermaid.`,
  "requirementDiagram": `# requirementDiagram
Use for requirements linked to tests or implementation elements.
Syntax:
requirementDiagram
  requirement R {
    id: 1
    text: "Requirement text"
    risk: low
    verifymethod: test
  }
  element E {
    type: test
  }
  E - verifies -> R
Requirement fields are id, text, risk, and verifymethod. Relationship types
include contains, derives, satisfies, verifies, refines, and traces. Optional
frontmatter config may set requirement and themeVariables values documented
by Mermaid.`,
  "usecase-beta": `# usecase-beta
Use for actors and system capabilities.
Syntax:
usecase-beta
direction LR
actor User
systemBoundary App
  Login("Log in")
end
User --> Login
Use actor declarations, systemBoundary blocks, and --> relationships. Use
..> for include/extend relationships when the evidence supports them.
Optional frontmatter config may set usecase and themeVariables values documented
by Mermaid.`,
  "C4Context": `# C4Context
Use for users, systems, boundaries, and integrations.
Syntax:
C4Context
  Person(user, "User")
  System(app, "Application")
  System_Ext(github, "GitHub")
  Rel(user, app, "Uses")
  Rel(app, github, "Calls")
Use stable aliases and Person, System, System_Ext, SystemDb, Boundary, Rel,
and BiRel forms. C4 is experimental and compatible with C4-PlantUML style.
Optional frontmatter config may set c4 and themeVariables values documented
by Mermaid.`,
  "zenuml": `# zenuml
Use for compact, nested call sequences.
Syntax:
zenuml
  Client->API: request
  API->Worker: process
  Worker->API: result
  API->Client: response
Participants may be implicit. Use nested braces for synchronous calls and
if/else, loop, opt, par, and try/catch only when useful. Optional frontmatter
config may set zenuml and themeVariables values documented by Mermaid.`,
  "packet": `# packet
Use for binary packet fields, bit ranges, and protocol layout.
Syntax:
packet
0-7: "Header"
8-31: "Payload"
Use explicit bit ranges or +N relative widths. Every field needs a quoted
label. Do not use this for ordinary JSON or API request flow. Optional
frontmatter config may set packet and themeVariables values documented by
Mermaid.`,
  "architecture-beta": `# architecture-beta
Use for services, containers, storage, deployment, and infrastructure topology.
Syntax:
architecture-beta
  group api(cloud)[API]
  service db(database)[Database] in api
  service app(server)[Application] in api
  db:R -- L:app
Declare groups and services before edges. Built-in icons include cloud,
database, disk, internet, and server. Edge ports are T, B, L, or R. Optional
frontmatter config may set architecture, including randomize, seed,
nodeSeparation, and idealEdgeLengthMultiplier, plus themeVariables.`,
  "eventmodeling": `# eventmodeling
Use for UI/processor actions, commands, read models, and events over time.
Syntax:
eventmodeling
tf 01 ui Screen
tf 02 cmd Save
tf 03 evt Saved
Entity types include ui, pcr, cmd, rmo, and evt. Use unique frame numbers.
Use rf for a reset frame and ->> for multiple read-model relations. Optional
frontmatter config may set eventmodeling and themeVariables values documented
by Mermaid.`,
  "treeView-beta": `# treeView-beta
Use for directory, file, module, or dependency hierarchies.
Exact syntax:
treeView-beta
    project/
        src/
            index.ts
        package.json
        README.md
Indentation defines parent-child relationships. Directories must end with /.
Labels may be bare or quoted. Do not use arrows, subgraph, or flowchart node
syntax. Optional frontmatter config:
---
config:
  treeView:
    rowIndent: 80
    lineThickness: 3
  themeVariables:
    treeView:
      labelFontSize: "20px"
      labelColor: "#333333"
      lineColor: "#777777"
---
Other documented treeView keys include paddingX, paddingY, showIcons,
defaultIconPack, filenameIcons, extensionIcons, iconColor, descriptionColor,
highlightBg, and highlightStroke. Use config only when it improves clarity.`,
};

const CONFIG_DOCS: Record<MermaidType, string> = {
  "flowchart": `Configuration:
---
config:
  flowchart:
    nodeSpacing: 50
    rankSpacing: 50
    padding: 8
    curve: basis
  themeVariables:
    primaryColor: "#e8f0fe"
    lineColor: "#555555"
---
Use nodeSpacing/rankSpacing for layout gaps, padding for outer space, and curve
for edge shape. Add config only when the default layout is hard to read.`,
  "swimlane-beta": `Configuration:
---
config:
  swimlane:
    lineHops: arc
    ignoreCrossLaneEdges: true
    optimizeRanksByCrossings: true
    automaticLaneOrdering: false
  themeVariables:
    primaryColor: "#e8f0fe"
---
lineHops accepts arc, gap, or false. Keep automaticLaneOrdering false when
source lane order carries meaning. Swimlane also reuses flowchart spacing.`,
  "sequenceDiagram": `Configuration:
---
config:
  sequence:
    hideUnusedParticipants: true
    actorMargin: 50
    messageMargin: 35
    mirrorActors: true
    rightAngles: false
    showSequenceNumbers: false
  themeVariables:
    actorBkg: "#e8f0fe"
    signalColor: "#333333"
---
Use hideUnusedParticipants to remove unused declarations, actor/message margins
for spacing, mirrorActors for repeated headers, and showSequenceNumbers only
when numbered traces are useful.`,
  "classDiagram": `Configuration:
---
config:
  class:
    nodeSpacing: 50
    rankSpacing: 50
    hideEmptyMembersBox: false
    hierarchicalNamespaces: true
    htmlLabels: false
  themeVariables:
    primaryColor: "#e8f0fe"
---
Use spacing for crowded graphs. Set hideEmptyMembersBox when empty compartments
add noise and hierarchicalNamespaces false for compact dotted namespaces.`,
  "stateDiagram-v2": `Configuration:
---
config:
  state:
    padding: 8
    nodeSpacing: 50
    rankSpacing: 50
    dividerMargin: 10
    defaultRenderer: dagre-wrapper
  themeVariables:
    primaryColor: "#e8f0fe"
    lineColor: "#555555"
---
Use padding and spacing for readability. Use defaultRenderer only when the
target renderer supports the chosen renderer.`,
  "erDiagram": `Configuration:
---
config:
  er:
    layoutDirection: TB
    minEntityWidth: 100
    minEntityHeight: 75
    entityPadding: 15
    nodeSpacing: 140
    rankSpacing: 80
    stroke: "#777777"
    fill: "#f0fff0"
    fontSize: 12
---
layoutDirection accepts TB, BT, LR, or RL. Use entity sizes and spacing for
crowded schemas. Use stroke/fill/fontSize only for readable contrast.`,
  "requirementDiagram": `Configuration:
---
config:
  requirement:
    rect_fill: "#f9f9f9"
    text_color: "#333333"
    rect_border_size: "0.5px"
    rect_border_color: "#bbbbbb"
    rect_min_width: 200
    rect_min_height: 100
    rect_padding: 10
    line_height: 20
    fontSize: 14
  themeVariables:
    lineColor: "#555555"
---
Use rect_* for requirement/element boxes and line_height/fontSize for
readability. Keep risk and verification semantics in diagram data.`,
  "usecase-beta": `Configuration:
---
config:
  usecase:
    actorFontSize: 14
    usecaseFontSize: 12
    actorFontWeight: normal
    usecaseFontWeight: normal
    nodeSpacing: 50
    rankSpacing: 50
    diagramPadding: 20
  themeVariables:
    primaryColor: "#e8f0fe"
---
Use font settings for legibility and spacing for crowded actor-capability
graphs. Font values must not contain ;, <, >, (, ), {, }, or backslash.`,
  "C4Context": `Configuration:
---
config:
  c4:
    diagramMarginX: 50
    diagramMarginY: 10
    c4ShapeMargin: 50
    c4ShapePadding: 20
    c4ShapeInRow: 4
    c4BoundaryInRow: 2
    width: 216
    height: 60
    useMaxWidth: true
---
Use shape margin/padding for spacing, shape/boundary counts for layout density,
and width/height for box size. C4 is experimental. Do not invent style calls.`,
  "zenuml": `Configuration:
ZenUML is an external Mermaid diagram integration and has no stable dedicated
zenuml block in Mermaid core config. Do not invent one. Use only frontmatter
options documented by the target renderer, such as supported title/theme
settings, and omit config when unsure.`,
  "packet": `Configuration:
---
config:
  packet:
    rowHeight: 32
    bitWidth: 32
    bitsPerRow: 32
    showBits: true
    paddingX: 5
    paddingY: 5
  themeVariables:
    packetBkg: "#e8f0fe"
---
Use bitsPerRow/bitWidth for layout, rowHeight for readability, showBits when
bit numbering distracts, and paddingX/paddingY for spacing.`,
  "architecture-beta": `Configuration:
---
config:
  architecture:
    padding: 40
    iconSize: 80
    fontSize: 16
    randomize: false
    nodeSeparation: 75
    idealEdgeLengthMultiplier: 1.5
    edgeElasticity: 0.45
    numIter: 2500
    seed: 1
---
Use padding/iconSize/fontSize for scale. Increase nodeSeparation or
idealEdgeLengthMultiplier when nodes overlap. Keep randomize false and seed
stable for reproducible output. Increase numIter only for dense diagrams.`,
  "eventmodeling": `Configuration:
---
config:
  eventmodeling:
    padding: 30
    rowHeight: 32
  themeVariables:
    primaryColor: "#e8f0fe"
---
Use padding for outer space and rowHeight for timeline readability. Do not use
config to hide incorrect frame numbers or inferred relations.`,
  "treeView-beta": `Configuration:
---
config:
  treeView:
    rowIndent: 80
    paddingX: 5
    paddingY: 5
    lineThickness: 3
    showIcons: true
    defaultIconPack: material-icon-theme
    filenameIcons:
      Dockerfile: docker
    extensionIcons:
      .ts: typescript
  themeVariables:
    treeView:
      labelFontSize: "20px"
      labelColor: "#333333"
      lineColor: "#777777"
      iconColor: "#546e7a"
      descriptionColor: "#6a9955"
      highlightBg: "rgba(255,193,7,0.15)"
      highlightStroke: "#ffc107"
---
rowIndent controls nesting distance, paddingX/Y label spacing, lineThickness
connector weight, and showIcons file/folder icons. Icon packs must be
registered by the renderer. Directories still require / and indentation.`,
};

export const MERMAID_TOOL = {
  type: "function",
  function: {
    name: "read-mermaid-syntaxes",
    description:
      "Read the LLM-friendly syntax, configuration, and examples for selected Mermaid diagram types.",
    parameters: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string", enum: [...MERMAID_TYPES] },
          uniqueItems: true,
          maxItems: 5,
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
  },
} as const;

export function readMermaidSyntaxes(
  args: Json,
  maxTools: number,
): string {
  const raw = args.tools;
  if (!Array.isArray(raw)) {
    throw new Error("read-mermaid-syntaxes requires a tools array");
  }
  const names = [...new Set(raw.map(String))];
  if (names.length === 0 || names.length > maxTools) {
    throw new Error(`read-mermaid-syntaxes accepts 1-${maxTools} tools`);
  }
  for (const name of names) {
    if (!(MERMAID_TYPES as readonly string[]).includes(name)) {
      throw new Error(`unsupported Mermaid syntax: ${name}`);
    }
  }
  return names.map((name) =>
    `${DOCS[name as MermaidType]}\n\n${CONFIG_DOCS[name as MermaidType]}`
  ).join("\n\n");
}
