# Pilot: four examples as the model will see them

Full system prompt of the first one, then for each: request, answer. Repairs show only the part of the request after the program.

## System prompt (short form)

```
Now you do not write a whole program. You add ONE section to a VERA-L program that already exists, and you write only that section, in exactly this form and nothing else:
<classes>
any @jsonable record classes the section needs, or nothing
</classes>
<fields>
one state field per line, as  name: type = initial value  (or nothing)
</fields>
<functions>
the handlers and helper functions the section needs
</functions>
<view>
statements that build the section and add it with sections.push(ui.Section(...));
</view>
Rules for the section:
- Begin the name of every class, field and function with c_ (classes with C_), so nothing clashes with the program.
- A handler returns only the fields it changes, followed by __PASSTHROUGH__ just before the closing brace, which stands for every other field of the state kept as it is: return {c_count: state.c_count + 1__PASSTHROUGH__};
- The view statements run inside view(state): they may read any state field, but the local variables of the program's other sections are not visible there.
- Do not repeat, change or restyle anything the program already has. Do what the section must do, completely.
- If the program already has a clock (Start, Stop, Reset buttons, a time shown) or a list of entries with its own Add button, the section draws no clock, no Start/Stop/Reset buttons and no second list of the same entries: it works with that state and shows only what is new.
- A message about an empty or wrong field (such as "Enter a task name") is shown only after the person has tried to add it, never while the field is still untouched.
- Show each piece of information once: no heading and caption that say the same thing, and no second view (a table, "splits") of entries the program already lists in rows. A figure is a progress bar or a number, not both; a list the program already has (its stops, its entries) is not listed again with a button added to each row -- the button goes where the program can take it, or the section names the item to act on; and one set of tabs or switches for one choice.
- A list the section keeps that starts empty has its own way to add to it, and to remove from it: an empty list nothing can fill is a dead end (Chore stars: "No rewards yet" with no way to add one).
- Every number the section shows is worked out from something on the screen or named in the request: progress toward a goal needs the goal, set on the screen or fixed by the request, not a percent of nothing.
- Never write a phone number, address or other real-world contact the request did not give: a made-up number (such as +1 800 555 0100) looks real to the person. Show a field for the person to fill in, or say to call their local emergency number.
- When some of the needs cannot be done but others can, write the section for the ones that can and add, for each one that cannot, <cannot need="the need, copied exactly">one short sentence for the person using the app, in plain words about their phone and its apps: what this app cannot do, and why. Never mention the language, the section, sdk.call or code</cannot> beside it. Answer a bare <cannot> only when none can be done.
- A need declined has no button or row that claims to do it. If the section offers the nearest thing instead (an event in the phone calendar for a notification it cannot send), its button says that thing ("Add to calendar"), and the <cannot> sentence says what is offered instead. A notice saying it cannot beside a button named for the same thing reads as broken.
- A need the section does in its own way is done, not declined: guidance written out as rows is the care card or tips card asked for, a list is a "card", a field the person fills in is a setting. <cannot need> is only for what the person does not get at all on this screen, never for how it looks.
- The section never calls sdk.call, except "Vera.Ask.text" as said below: what the phone does is not its job.
- Words written from what the person entered (suggestions, recipes, ideas) are never declined: "Vera.Ask.text" writes them.
- If the section cannot really do it with this language and these components -- it needs a camera, a live feed, the person's location or data the phone does not hold -- decline that need as above, beside the rest; a bare <cannot>one short sentence for the person using the app, in plain words about their phone and its apps: what this app cannot do, and why. Never mention the language, the section, sdk.call or code</cannot> only when none of the needs can be done. Never fake it with made-up data.
- Suggestions, ideas, recipes, tips or questions made FROM WHAT THE PERSON ENTERED (dinners from the items in their pantry, questions from their notes, a plan from the times they set) are written by the model while the app runs, never by the section: a fixed sentence with their words pasted in ("Roast vegetable tray, uses Spinach") is not a suggestion. The section has a button that asks, a "pending" text while it waits, and the answer shown as text:
    function suggest(state: AppState, ignored: number): AppState {
      sdk.call("Vera.Ask.text", ["prompt", "Two quick dinners using: " + names + ". One line each.", "maxWords", "60"], "onSuggested");
      return {c_ideas: "Thinking..."__PASSTHROUGH__};
    }
    function onSuggested(state: AppState, value: string): AppState { return {c_ideas: value__PASSTHROUGH__}; }
  An answer starting with "error" is shown as a failure the person can try again. Call it only from a button's handler, never from view() or a ticker; and never for numbers the app works out itself or for anything known when the app is made.

```

## grade-01 — first, family grades, split train, calls 1

### user

```
Request: weighted grade calculator

The section must do:
- the figure "Weight so far": the weights of all graded items added up (a percent: show it with the % sign) (the plan works it out as entryTotal; for entryTotal = 85 that is 85)
- the figure "Needed on rest": the average score needed on the remaining weight to reach the target (a percent: show it with the % sign) (the plan works it out as (targetGrade - currentGrade * totalWeight / 100) / (100 - totalWeight) * 100; for targetGrade = 90, currentGrade = 85, totalWeight = 60 that is 97.5)
- the figure "Current grade": the weighted average of the scores entered so far (a percent: show it with the % sign) (the plan works it out as entryTotal > 0 ? 0 : 0; for entryTotal = 0 that is 0)

The person sets these on the screen and nothing else uses them yet; the section uses them:
- "Target grade": state.targetGradeText (the number as typed; strings.toNumber reads it)

The program already has these: use them, do not make your own:
- a list of entries: state.entries is LogEntry[] with the fields {itemName: string, score: number, weight: number, minute: number}. Its form, its Add and Remove buttons and its rows are already on the screen. The section makes no list of its own for the same entries; to add one it copies state.entries into a new array, pushes a LogEntry (minute: time.hourOfDay() * 60 + time.minuteOfHour()) and returns {entries: thatArray __PASSTHROUGH__}.

Nothing they show is shown again: no second list, total, chart, Remove last or Start over button. While what the section works from is still empty, it shows one plain line saying what will appear and when, never a ui.EmptyState: the list above already has one (two empty states one under the other read as a broken screen).

The program so far, which the section joins (do not repeat it):
import * as ui from "std/ui"

@jsonable
class LogEntry {
  itemName: string;
  score: number;
  weight: number;
  minute: number;
}

@jsonable
class AppState {
  targetGradeText: string;
  entries: LogEntry[];
  draft_itemName: string;
  draft_score: string;
  draft_weight: string;
  removedEntries: LogEntry[];
  removedAt: number;
  settingsOpen: boolean;
}

function init(): AppState {
  let emptyEntries: LogEntry[] = [];
  return {targetGradeText: "90", entries: emptyEntries, draft_itemName: "", draft_score: "", draft_weight: "", removedEntries: emptyEntries, removedAt: -1, settingsOpen: false};
}

function share(a: number, b: number): number {
  if (b === 0) { return 0; }
  return a / b;
}



function set_targetGrade(state: AppState, value: string): AppState {
  return {targetGradeText: value, entries: state.entries, draft_itemName: state.draft_itemName, draft_score: state.draft_score, draft_weight: state.draft_weight, removedEntries: state.removedEntries, removedAt: state.removedAt, settingsOpen: state.settingsOpen};
}



function set_draft_itemName(state: AppState, value: string): AppState {
  return {draft_itemName: value, targetGradeText: state.targetGradeText, entries: state.entries, draft_score: state.draft_score, draft_weight: state.draft_weight, removedEntries: state.removedEntries, removedAt: state.removedAt, settingsOpen: state.settingsOpen};
}

function set_draft_score(state: AppState, value: string): AppState {
  return {draft_score: value, targetGradeText: state.targetGradeText, entries: state.entries, draft_itemName: state.draft_itemName, draft_weight: state.draft_weight, removedEntries: state.removedEntries, removedAt: state.removedAt, settingsOpen: state.settingsOpen};
}

function set_draft_weight(state: AppState, value: string): AppState {
  return {draft_weight: value, targetGradeText: state.targetGradeText, entries: state.entries, draft_itemName: state.draft_itemName, draft_score: state.draft_score, removedEntries: state.removedEntries, removedAt: state.removedAt, settingsOpen: state.settingsOpen};
}

function addEntry(state: AppState, ignored: number): AppState {
  if (strings.trim(state.draft_itemName) === "") { return state; }
  let none: LogEntry[] = [];
  let entry: LogEntry = {itemName: strings.trim(state.draft_itemName), score: strings.toNumber(state.draft_score, 0), weight: strings.toNumber(state.draft_weight, 0), minute: time.hourOfDay() * 60 + time.minuteOfHour()};
  let out: LogEntry[] = [];
  for (let e: LogEntry of state.entries) { out.push(e); }
  out.push(entry);
  return {entries: out, removedEntries: none, draft_itemName: "", draft_score: "", draft_weight: "", targetGradeText: state.targetGradeText, removedAt: state.removedAt, settingsOpen: state.settingsOpen};
}

function removeEntry(state: AppState, value: number): AppState {
  let out: LogEntry[] = [];
  let gone: LogEntry[] = [];
  let i: number = 0;
  while (i < state.entries.length()) {
    if (i !== value) { out.push(state.entries[i]); } else { gone.push(state.entries[i]); }
    i = i + 1;
  }
  return {entries: out, removedEntries: gone, removedAt: value, targetGradeText: state.targetGradeText, draft_itemName: state.draft_itemName, draft_score: state.draft_score, draft_weight: state.draft_weight, settingsOpen: state.settingsOpen};
}

function undoRemove(state: AppState, ignored: number): AppState {
  if (state.removedEntries.length() === 0) { return state; }
  let out: LogEntry[] = [];
  let none: LogEntry[] = [];
  let i: number = 0;
  while (i < state.entries.length()) {
    if (i === state.removedAt) { out.push(state.removedEntries[0]); }
    out.push(state.entries[i]);
    i = i + 1;
  }
  if (state.removedAt >= state.entries.length()) { out.push(state.removedEntries[0]); }
  return {entries: out, removedEntries: none, removedAt: -1, targetGradeText: state.targetGradeText, draft_itemName: state.draft_itemName, draft_score: state.draft_score, draft_weight: state.draft_weight, settingsOpen: state.settingsOpen};
}

function expireUndo(state: AppState, elapsedMs: number): AppState {
  let none: LogEntry[] = [];
  return {removedEntries: none, removedAt: -1, targetGradeText: state.targetGradeText, entries: state.entries, draft_itemName: state.draft_itemName, draft_score: state.draft_score, draft_weight: state.draft_weight, settingsOpen: state.settingsOpen};
}





function toggleSettings(state: AppState, ignored: number): AppState {
  return {settingsOpen: !state.settingsOpen, targetGradeText: state.targetGradeText, entries: state.entries, draft_itemName: state.draft_itemName, draft_score: state.draft_score, draft_weight: state.draft_weight, removedEntries: state.removedEntries, removedAt: state.removedAt};
}

function view(state: AppState): ui.View {
  let sections: ui.View[] = [];
  sections.push(ui.Header("default", "Weighted Grade", "GRADE CALC", "See your weighted course grade as you add scores", ""));
  {
      let targetGrade: number = strings.toNumber(state.targetGradeText, 0);
      let entryCount: number = state.entries.length();
      let entryTotal: number = 0;
      for (let e: LogEntry of state.entries) { entryTotal = entryTotal + e.score; }
    let rows: ui.View[] = [];
    let i: number = entryCount - 1;
    while (i >= 0 && i > entryCount - 21) {
      let e: LogEntry = state.entries[i];
      let sub: string = ui.formatNumber(e.weight, 1) + "%" + " · " + "Added " + ui.clockToString(e.minute);
      rows.push(ui.ListItem("default", e.itemName, sub, ui.formatNumber(e.score, 1) + "%", "", 0, false, ""));
      rows.push(ui.ActionBar("end", [ui.Button("secondary", "Remove", "removeEntry", i, true)]));
      i = i - 1;
    }
    sections.push(ui.Section("content", "", "", [ui.TextField("default", "Item", state.draft_itemName, "set_draft_itemName"), ui.TextField("default", "Score", state.draft_score, "set_draft_score", "number"), ui.TextField("default", "Weight", state.draft_weight, "set_draft_weight", "number"), ui.ActionBar("end", [ui.Button("primary", "Add", "addEntry", 0, strings.trim(state.draft_itemName) !== "")])]));
    sections.push(ui.Section("content", "", "", [ui.SectionHeader("default", "Graded items", "Newest first", ui.numberToString(entryCount)), ui.When(entryCount === 0, ui.EmptyState("default", "Nothing added yet", "Fill in the fields above and tap Add.", "", "", "list")), ui.When(entryCount > 0, ui.ListGroup("default", "", rows)), ui.When(state.removedEntries.length() > 0, ui.Snackbar("default", "Removed", "Undo", "undoRemove")), ui.Ticker("default", "undoClock", 6000 + state.entries.length() % 7, state.removedEntries.length() > 0, "expireUndo")]));
  }
  {
    let settingsWord: string = "Show";
    if (state.settingsOpen) { settingsWord = "Hide"; }
    sections.push(ui.Section("supporting", "", "", [
      ui.ListItem("default", "Settings", "1 setting", settingsWord, "toggleSettings", 0, true, ""),
      ui.When(state.settingsOpen, ui.Column("default", [ui.TextField("default", "Target grade (%)", state.targetGradeText, "set_targetGrade", "number")]))
    ]));
  }
  return ui.AppTheme("technical", "", sections);
}
```

### assistant

```
<classes>
</classes>
<fields>
</fields>
<functions>
function c_weightSoFar(state: AppState): number {
  let total: number = 0;
  for (let e: LogEntry of state.entries) { total = total + e.weight; }
  return total;
}

function c_currentGrade(state: AppState): number {
  let weighted: number = 0;
  let weight: number = 0;
  for (let e: LogEntry of state.entries) {
    weighted = weighted + e.score * e.weight;
    weight = weight + e.weight;
  }
  if (weight <= 0) { return 0; }
  return weighted / weight;
}

function c_neededOnRest(state: AppState): number {
  let target: number = strings.toNumber(state.targetGradeText, 0);
  let weight: number = c_weightSoFar(state);
  let current: number = c_currentGrade(state);
  let rest: number = 100 - weight;
  if (rest <= 0) { return 0; }
  return (target - current * weight / 100) / rest * 100;
}
</functions>
<view>
{
  let c_weight: number = c_weightSoFar(state);
  let c_current: number = c_currentGrade(state);
  let c_needed: number = c_neededOnRest(state);
  let c_rest: number = 100 - c_weight;
  let c_needText: string = "";
  if (c_weight <= 0) {
    c_needText = "Add a graded item to see your standing.";
  } else if (c_rest <= 0) {
    c_needText = "All weight is graded, so nothing is left to make up.";
  } else if (c_needed > 100) {
    c_needText = "Above 100% — out of reach with the weight left.";
  } else if (c_needed < 0) {
    c_needText = "Already above target with the weight left.";
  } else {
    c_needText = "On the " + ui.formatNumber(c_rest, 1) + "% still to come.";
  }
  let c_needValue: string = ui.formatNumber(c_needed, 1) + "%";
  if (c_weight <= 0) { c_needValue = "—"; }
  sections.push(ui.Section("summary", "Standing", "Weighted across what you have graded", [
    ui.MetricGroup("default", 3, [
      ui.NumberStat("default", "Weight so far", c_weight, "", "%", 1, "of 100% graded", "chart"),
      ui.NumberStat("accent", "Current grade", c_current, "", "%", 1, "weighted average", "star"),
      ui.Stat("default", "Needed on rest", c_needValue, c_needText, "navigate")
    ])
  ]));
}
</view>
```

## grade-02 — first, family grades, split train, calls 1

### user

```
Request: gpa calculator with credits

The section must do:
- the figure "Grade points": each grade's points times its credits, added up (the plan works it out as entryCount * 0; for entryCount = 0 that is 0)
- the figure "GPA": grade points divided by total credits (the plan works it out as weightedPoints / totalCredits; for weightedPoints = 48, totalCredits = 15 that is 3.2)

The person sets these on the screen and nothing else uses them yet; the section uses them:
- "Courses": state.courseCount

The program already has these: use them, do not make your own:
- a list of entries: state.entries is LogEntry[] with the fields {courseName: string, credits: number, grade: string, minute: number}. Its form, its Add and Remove buttons and its rows are already on the screen. The section makes no list of its own for the same entries; to add one it copies state.entries into a new array, pushes a LogEntry (minute: time.hourOfDay() * 60 + time.minuteOfHour()) and returns {entries: thatArray __PASSTHROUGH__}.

Nothing they show is shown again: no second list, total, chart, Remove last or Start over button. While what the section works from is still empty, it shows one plain line saying what will appear and when, never a ui.EmptyState: the list above already has one (two empty states one under the other read as a broken screen).

The program so far, which the section joins (do not repeat it):
import * as ui from "std/ui"

@jsonable
class LogEntry {
  courseName: string;
  credits: number;
  grade: string;
  minute: number;
}

@jsonable
class AppState {
  courseCount: number;
  entries: LogEntry[];
  draft_courseName: string;
  draft_credits: string;
  draft_grade: string;
  removedEntries: LogEntry[];
  removedAt: number;
}

function init(): AppState {
  let emptyEntries: LogEntry[] = [];
  return {courseCount: 4, entries: emptyEntries, draft_courseName: "", draft_credits: "", draft_grade: "", removedEntries: emptyEntries, removedAt: -1};
}

function share(a: number, b: number): number {
  if (b === 0) { return 0; }
  return a / b;
}



function set_courseCount(state: AppState, value: number): AppState {
  return {courseCount: value, entries: state.entries, draft_courseName: state.draft_courseName, draft_credits: state.draft_credits, draft_grade: state.draft_grade, removedEntries: state.removedEntries, removedAt: state.removedAt};
}



function set_draft_courseName(state: AppState, value: string): AppState {
  return {draft_courseName: value, courseCount: state.courseCount, entries: state.entries, draft_credits: state.draft_credits, draft_grade: state.draft_grade, removedEntries: state.removedEntries, removedAt: state.removedAt};
}

function set_draft_credits(state: AppState, value: string): AppState {
  return {draft_credits: value, courseCount: state.courseCount, entries: state.entries, draft_courseName: state.draft_courseName, draft_grade: state.draft_grade, removedEntries: state.removedEntries, removedAt: state.removedAt};
}

function set_draft_grade(state: AppState, value: string): AppState {
  return {draft_grade: value, courseCount: state.courseCount, entries: state.entries, draft_courseName: state.draft_courseName, draft_credits: state.draft_credits, removedEntries: state.removedEntries, removedAt: state.removedAt};
}

function addEntry(state: AppState, ignored: number): AppState {
  if (strings.trim(state.draft_courseName) === "") { return state; }
  let none: LogEntry[] = [];
  let entry: LogEntry = {courseName: strings.trim(state.draft_courseName), credits: strings.toNumber(state.draft_credits, 0), grade: strings.trim(state.draft_grade), minute: time.hourOfDay() * 60 + time.minuteOfHour()};
  let out: LogEntry[] = [];
  for (let e: LogEntry of state.entries) { out.push(e); }
  out.push(entry);
  return {entries: out, removedEntries: none, draft_courseName: "", draft_credits: "", draft_grade: "", courseCount: state.courseCount, removedAt: state.removedAt};
}

function removeEntry(state: AppState, value: number): AppState {
  let out: LogEntry[] = [];
  let gone: LogEntry[] = [];
  let i: number = 0;
  while (i < state.entries.length()) {
    if (i !== value) { out.push(state.entries[i]); } else { gone.push(state.entries[i]); }
    i = i + 1;
  }
  return {entries: out, removedEntries: gone, removedAt: value, courseCount: state.courseCount, draft_courseName: state.draft_courseName, draft_credits: state.draft_credits, draft_grade: state.draft_grade};
}

function undoRemove(state: AppState, ignored: number): AppState {
  if (state.removedEntries.length() === 0) { return state; }
  let out: LogEntry[] = [];
  let none: LogEntry[] = [];
  let i: number = 0;
  while (i < state.entries.length()) {
    if (i === state.removedAt) { out.push(state.removedEntries[0]); }
    out.push(state.entries[i]);
    i = i + 1;
  }
  if (state.removedAt >= state.entries.length()) { out.push(state.removedEntries[0]); }
  return {entries: out, removedEntries: none, removedAt: -1, courseCount: state.courseCount, draft_courseName: state.draft_courseName, draft_credits: state.draft_credits, draft_grade: state.draft_grade};
}

function expireUndo(state: AppState, elapsedMs: number): AppState {
  let none: LogEntry[] = [];
  return {removedEntries: none, removedAt: -1, courseCount: state.courseCount, entries: state.entries, draft_courseName: state.draft_courseName, draft_credits: state.draft_credits, draft_grade: state.draft_grade};
}





function view(state: AppState): ui.View {
  let sections: ui.View[] = [];
  sections.push(ui.Header("default", "GPA Calculator", "GRADES", "Turn course grades and credits into your GPA", ""));
  {
      let courseCount: number = state.courseCount;
      let gradePointsA: number = 4;
      let gradePointsB: number = 3;
      let gradePointsC: number = 2;
      let gradePointsD: number = 1;
      let gradePointsF: number = 0;
      let entryCount: number = state.entries.length();
      let entryTotal: number = 0;
      for (let e: LogEntry of state.entries) { entryTotal = entryTotal + e.credits; }
      let totalCredits: number = entryTotal;
    sections.push(ui.Section("content", "", "", [ui.NumberField("default", "Courses", state.courseCount, 1, 12, "set_courseCount")]));
    sections.push(ui.Section("summary", "", "", [ui.MetricGroup("default", 1, [ui.NumberStat("default", "Total credits", totalCredits, "", " credits", 1, "", "chart", 0)])]));
    let rows: ui.View[] = [];
    let i: number = entryCount - 1;
    while (i >= 0 && i > entryCount - 21) {
      let e: LogEntry = state.entries[i];
      let sub: string = e.grade + " · " + "Added " + ui.clockToString(e.minute);
      rows.push(ui.ListItem("default", e.courseName, sub, ui.formatNumber(e.credits, 0), "", 0, false, ""));
      rows.push(ui.ActionBar("end", [ui.Button("secondary", "Remove", "removeEntry", i, true)]));
      i = i - 1;
    }
    sections.push(ui.Section("content", "", "", [ui.TextField("default", "Course", state.draft_courseName, "set_draft_courseName"), ui.TextField("default", "Credits", state.draft_credits, "set_draft_credits", "number"), ui.TextField("default", "Grade", state.draft_grade, "set_draft_grade"), ui.ActionBar("end", [ui.Button("primary", "Add", "addEntry", 0, strings.trim(state.draft_courseName) !== "")])]));
    sections.push(ui.Section("content", "", "", [ui.SectionHeader("default", "Courses", "Newest first", ui.numberToString(entryCount)), ui.When(entryCount === 0, ui.EmptyState("default", "Nothing added yet", "Fill in the fields above and tap Add.", "", "", "list")), ui.When(entryCount > 0, ui.ListGroup("default", "", rows)), ui.When(state.removedEntries.length() > 0, ui.Snackbar("default", "Removed", "Undo", "undoRemove")), ui.Ticker("default", "undoClock", 6000 + state.entries.length() % 7, state.removedEntries.length() > 0, "expireUndo")]));
  }
  return ui.AppTheme("technical", "", sections);
}
```

### assistant

```
<classes>
</classes>
<fields>
</fields>
<functions>
function c_gradePoints(grade: string): number {
  let g: string = strings.toUpperCase(strings.trim(grade));
  if (g === "A" || g === "A+" || g === "A-") { return 4; }
  if (g === "B" || g === "B+" || g === "B-") { return 3; }
  if (g === "C" || g === "C+" || g === "C-") { return 2; }
  if (g === "D" || g === "D+" || g === "D-") { return 1; }
  return 0;
}

function c_weightedPoints(state: AppState): number {
  let total: number = 0;
  for (let e: LogEntry of state.entries) {
    total = total + c_gradePoints(e.grade) * e.credits;
  }
  return total;
}

function c_totalCredits(state: AppState): number {
  let total: number = 0;
  for (let e: LogEntry of state.entries) {
    total = total + e.credits;
  }
  return total;
}

function c_gpa(state: AppState): number {
  let credits: number = c_totalCredits(state);
  if (credits <= 0) { return 0; }
  return c_weightedPoints(state) / credits;
}
</functions>
<view>
{
  let c_count: number = state.entries.length();
  let c_points: number = c_weightedPoints(state);
  let c_credits: number = c_totalCredits(state);
  let c_average: number = c_gpa(state);
  if (c_count === 0) {
    sections.push(ui.Section("summary", "", "", [
      ui.Text("muted", "Your grade points and GPA appear here once you add a course with credits and a grade.")
    ]));
  } else {
    sections.push(ui.Section("summary", "", "", [
      ui.MetricGroup("default", 2, [
        ui.NumberStat("default", "Grade points", c_points, "", "", 1, "across " + ui.numberToString(c_credits) + " credits", "chart", 0),
        ui.NumberStat("accent", "GPA", c_average, "", "", 1, "grade points ÷ credits", "star", 2)
      ])
    ]));
  }
}
</view>
```

## count-02 — repair, family date-math, split train, calls 2

### user

```
...


Your section was:
<cannot need="the figure &quot;Age in days&quot;: How many days have passed since the birth date (the plan works it out as floor((elapsed) / 86400); for elapsed = 31536000 that is 365)">The birth date is typed as text, and this app has no way to turn a typed date into a real calendar date, so it cannot count the days since then.</cannot>

It failed:
The answer was not in the form asked for: <classes>, <fields>, <functions> and <view>.

Write the whole section again, fixed, in the same form.
```

### assistant

```
<classes>
</classes>
<fields>
</fields>
<functions>
function c_parseDay(state: AppState): number {
  let s: string = strings.trim(state.birthDate);
  if (strings.length(s) === 0) { return -1; }
  let parts: string[] = strings.split(s, "-");
  if (parts.length() !== 3) { return -1; }
  let y: number = strings.toNumber(parts[0], -1);
  let m: number = strings.toNumber(parts[1], -1);
  let d: number = strings.toNumber(parts[2], -1);
  if (y < 1900 || y > 2200) { return -1; }
  if (m < 1 || m > 12) { return -1; }
  if (d < 1 || d > 31) { return -1; }
  let a: number = math.floor((14 - m) / 12);
  let yy: number = y + 4800 - a;
  let mm: number = m + 12 * a - 3;
  let jdn: number = d + math.floor((153 * mm + 2) / 5) + 365 * yy + math.floor(yy / 4) - math.floor(yy / 100) + math.floor(yy / 400) - 32045;
  let epoch: number = 2440588;
  return jdn - epoch;
}

function c_ageDays(state: AppState): number {
  let day: number = c_parseDay(state);
  if (day < 0) { return -1; }
  let today: number = time.daysSinceEpoch();
  let diff: number = today - day;
  if (diff < 0) { return -1; }
  return diff;
}
</functions>
<view>
{
  let c_day: number = c_parseDay(state);
  let c_age: number = c_ageDays(state);
  let c_rows: ui.View[] = [];
  if (strings.length(strings.trim(state.birthDate)) === 0) {
    c_rows.push(ui.Text("caption", "Type your birth date as YYYY-MM-DD, for example 1990-05-14."));
  } else {
    if (c_day < 0) {
      c_rows.push(ui.InsetBanner("warning", "Check the date", "Use the form YYYY-MM-DD, for example 1990-05-14.", "", "", "warning"));
    } else {
      if (c_age < 0) {
        c_rows.push(ui.InsetBanner("warning", "Date is in the future", "The birth date must be today or earlier.", "", "", "warning"));
      } else {
        c_rows.push(ui.MetricGroup("default", 1, [
          ui.NumberStat("accent", "Age in days", c_age, "", " days", 1, "since " + state.birthDate, "calendar")
        ]));
      }
    }
  }
  sections.push(ui.Section("summary", "Age in days", "", c_rows));
}
</view>
```

## flash-02 — repair, family flashcards, split train, calls 2

### user

```
...


Your section:
<classes>
@jsonable
class C_Card {
  word: string;
  definition: string;
  missed: boolean;
  known: boolean;
}
</classes>
<fields>
c_cards: C_Card[] = [];
c_index: number = 0;
c_flipped: boolean = false;
c_roundDone: boolean = false;
</fields>
<functions>
function c_starterDeck(): C_Card[] {
  let deck: C_Card[] = [];
  deck.push({word: "abundant", definition: "existing in large quantities", missed: false, known: false});
  deck.push({word: "candid", definition: "honest and direct", missed: false, known: false});
  deck.push({word: "diligent", definition: "showing careful effort", missed: false, known: false});
  deck.push({word: "frugal", definition: "sparing with money", missed: false, known: false});
  deck.push({word: "gregarious", definition: "fond of company", missed: false, known: false});
  deck.push({word: "lucid", definition: "clear and easy to understand", missed: false, known: false});
  deck.push({word: "meticulous", definition: "extremely careful about detail", missed: false, known: false});
  deck.push({word: "resilient", definition: "able to recover quickly", missed: false, known: false});
  deck.push({word: "tenacious", definition: "holding on firmly", missed: false, known: false});
  deck.push({word: "vivid", definition: "producing strong clear images", missed: false, known: false});
  return deck;
}

function c_ensureDeck(state: AppState): C_Card[] {
  if (state.c_cards.length() === 0) {
    return c_starterDeck();
  }
  return state.c_cards;
}

function c_flip(state: AppState, ignored: number): AppState {
  let cards: C_Card[] = c_ensureDeck(state);
  return {c_cards: cards, c_flipped: !state.c_flipped__PASSTHROUGH__};
}

function c_mark(state: AppState, value: number): AppState {
  let cards: C_Card[] = c_ensureDeck(state);
  let out: C_Card[] = [];
  let i: number = 0;
  while (i < cards.length()) {
    let c: C_Card = cards[i];
    if (i === state.c_index) {
      let missed: boolean = value === 1;
      out.push({word: c.word, definition: c.definition, missed: missed, known: !missed});
    } else {
      out.push(c);
    }
    i = i + 1;
  }
  let next: number = state.c_index + 1;
  let done: boolean = next >= cards.length();
  return {c_cards: out, c_index: next, c_flipped: false, c_roundDone: done__PASSTHROUGH__};
}

function c_restart(state: AppState, ignored: number): AppState {
  let cards: C_Card[] = c_ensureDeck(state);
  let out: C_Card[] = [];
  for (let c: C_Card of cards) {
    out.push({word: c.word, definition: c.definition, missed: false, known: false});
  }
  return {c_cards: out, c_index: 0, c_flipped: false, c_roundDone: false__PASSTHROUGH__};
}

function c_reviewMissed(state: AppState, ignored: number): AppState {
  let cards: C_Card[] = c_ensureDeck(state);
  let out: C_Card[] = [];
  for (let c: C_Card of cards) {
    if (c.missed) {
      out.push({word: c.word, definition: c.definition, missed: false, known: false});
    }
  }
  if (out.length() === 0) {
    return {c_cards: cards__PASSTHROUGH__};
  }
  return {c_cards: out, c_index: 0, c_flipped: false, c_roundDone: false__PASSTHROUGH__};
}

function c_clearMissed(state: AppState, ignored: number): AppState {
  let cards: C_Card[] = c_ensureDeck(state);
  let out: C_Card[] = [];
  for (let c: C_Card of cards) {
    out.push({word: c.word, definition: c.definition, missed: false, known: c.known});
  }
  return {c_cards: out__PASSTHROUGH__};
}
</functions>
<view>
{
  let cards: C_Card[] = state.c_cards;
  if (cards.length() === 0) {
    cards = c_starterDeck();
  }
  let total: number = cards.length();
  let missedCount: number = 0;
  let knownCount: number = 0;
  for (let c: C_Card of cards) {
    if (c.missed) { missedCount = missedCount + 1; }
    if (c.known) { knownCount = knownCount + 1; }
  }
  let idx: number = state.c_index;
  let inRound: boolean = idx < total && !state.c_roundDone;
  let front: string = "";
  let back: string = "";
  if (inRound) {
    front = cards[idx].word;
    back = cards[idx].definition;
  }
  let shown: string = front;
  if (state.c_flipped) {
    shown = back;
  }
  let faceLabel: string = "WORD";
  if (state.c_flipped) {
    faceLabel = "DEFINITION";
  }
  let progressText: string = ui.numberToString(idx) + " of " + ui.numberToString(total);

  let cardChildren: ui.View[] = [];
  cardChildren.push(ui.Text("eyebrow", faceLabel));
  cardChildren.push(ui.Text("title", shown));
  cardChildren.push(ui.Text("caption", "Tap the card to flip"));

  let reviewRows: ui.View[] = [];
  for (let c: C_Card of cards) {
    if (c.missed) {
      reviewRows.push(ui.ListItem("warning", c.word, c.definition, "", "", 0, true, "warning"));
    }
  }

  let body: ui.View[] = [];
  body.push(ui.SectionHeader("default", "Round", progressText, ""));
  if (inRound) {
    body.push(ui.Card("surface", [
      ui.Motion("flip", idx * 2 + (state.c_flipped ? 1 : 0), cardChildren)
    ]));
    body.push(ui.ActionBar("spread", [
      ui.Button("secondary", "Flip card", "c_flip", 0, true),
      ui.Button("success", "Known", "c_mark", 0, true),
      ui.Button("danger", "Missed", "c_mark", 1, true)
    ]));
  } else {
    body.push(ui.InsetBanner("success", "Round complete",
      "You marked " + ui.numberToString(knownCount) + " known and " + ui.numberToString(missedCount) + " missed.",
      "Start over", "c_restart", "check"));
  }

  let reviewChildren: ui.View[] = [];
  if (missedCount === 0) {
    reviewChildren.push(ui.EmptyState("default", "No missed words",
      "Words you mark as missed will collect here for review.", "", "", "list"));
  } else {
    reviewChildren.push(ui.ListGroup("default", "", reviewRows));
    reviewChildren.push(ui.ActionBar("end", [
      ui.Button("primary", "Review missed", "c_reviewMissed", 0, true),
      ui.Button("secondary", "Clear pile", "c_clearMissed", 0, true)
    ]));
  }

  sections.push(ui.Section("content", "Flashcards", "Flip, then mark known or missed", body));
  sections.push(ui.Section("content", "Review pile", ui.numberToString(missedCount) + " missed", reviewChildren));
}
</view>

It failed:
173:54 E1001 expected ), found ?
    line 173: ui.Motion("flip", idx * 2 + (state.c_flipped ? 1 : 0), cardChildren)
    fix: there is no ?: in VERA: declare the value with let, then set it in an if/else before the line that uses it

Mend your section by edits, not by writing it again. Write one block per change:
<<<<<<< SEARCH
lines copied exactly from your section above
=======
the lines that replace them
>>>>>>> REPLACE
Each SEARCH part must match exactly one place in your section -- not in the program so far -- so copy whole lines, with enough of them to be unique; to add a function or a field, replace a nearby line with itself and the new lines. Fix what failed and anything else that would fail the same way. Write nothing outside the blocks, except <cannot need="...">...</cannot> for a need this phone cannot do.
```

### assistant

```
<<<<<<< SEARCH
  let progressText: string = ui.numberToString(idx) + " of " + ui.numberToString(total);
=======
  let progressText: string = ui.numberToString(idx) + " of " + ui.numberToString(total);
  let flipTrigger: number = idx * 2;
  if (state.c_flipped) {
    flipTrigger = idx * 2 + 1;
  }
>>>>>>> REPLACE
<<<<<<< SEARCH
      ui.Motion("flip", idx * 2 + (state.c_flipped ? 1 : 0), cardChildren)
=======
      ui.Motion("flip", flipTrigger, cardChildren)
>>>>>>> REPLACE
```
