import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUnmappedCostSectionPhaseUpdates,
  suggestForecastPhaseId,
} from "./project-phase-alignment.ts";

const phases = [
  { id: "site", name: "Site Establishment & Protection", sort: 0 },
  { id: "demo", name: "Demolition & Strip Out", sort: 1 },
  { id: "structure", name: "Structural Alterations & Framing", sort: 2 },
  { id: "rough-in", name: "Services Rough In", sort: 3 },
  { id: "linings", name: "Internal Linings & Waterproofing", sort: 4 },
  { id: "finishes", name: "Internal Finishes", sort: 5 },
  { id: "joinery", name: "Joinery & Fixed Elements", sort: 6 },
  { id: "fit-off", name: "Fit Off", sort: 7 },
  { id: "paint", name: "Painting & Final Detail", sort: 8 },
  { id: "external", name: "External Works", sort: 9 },
  { id: "pc", name: "Practical Completion", sort: 10 },
  { id: "handover", name: "Handover & Close Out", sort: 11 },
];

test("estimate trade headings resolve to the corresponding Timeline phase", () => {
  assert.equal(suggestForecastPhaseId("Preliminaries & Site", phases), "site");
  assert.equal(suggestForecastPhaseId("Earthworks / Footings", phases), "structure");
  assert.equal(suggestForecastPhaseId("Electrical", phases), "rough-in");
  assert.equal(suggestForecastPhaseId("Joinery / Cabinetry", phases), "joinery");
  assert.equal(suggestForecastPhaseId("Stone & Benchtops", phases), "joinery");
  assert.equal(suggestForecastPhaseId("Glazing, Shower Screens & Mirrors", phases), "fit-off");
  assert.equal(suggestForecastPhaseId("Painting & Decorative Finishes", phases), "paint");
  assert.equal(suggestForecastPhaseId("Handover & Completion", phases), "handover");
  assert.equal(suggestForecastPhaseId("Contingency", phases), null);
});

test("automatic alignment preserves manual links and leaves ambiguous sections alone", () => {
  assert.deepEqual(
    buildUnmappedCostSectionPhaseUpdates(
      [
        { id: "electrical", name: "Electrical", forecast_phase_id: null },
        { id: "manual", name: "Demolition", forecast_phase_id: "custom" },
        { id: "contingency", name: "Contingency", forecast_phase_id: null },
      ],
      phases
    ),
    [{ id: "electrical", forecast_phase_id: "rough-in" }]
  );
});

test("current Work board phase names align without forcing ambiguous trades", () => {
  const currentBoardPhases = [
    { id: "site", name: "Site Setup", sort: 0 },
    { id: "demo", name: "Demolition-External", sort: 1 },
    { id: "rough", name: "Rough-in-External", sort: 2 },
    { id: "wet", name: "Waterproofing & Tiling", sort: 3 },
    { id: "fitoff", name: "Fit-off", sort: 4 },
    { id: "handover", name: "Handover", sort: 5 },
    { id: "plaster", name: "Plasterboard, Flushing & Cornice", sort: 6 },
    { id: "slab", name: "Slab & Footings", sort: 7 },
  ];

  assert.equal(suggestForecastPhaseId("Preliminaries & Site", currentBoardPhases), "site");
  assert.equal(suggestForecastPhaseId("Demolition", currentBoardPhases), "demo");
  assert.equal(suggestForecastPhaseId("Earthworks / Footings", currentBoardPhases), "slab");
  assert.equal(suggestForecastPhaseId("Plasterboard", currentBoardPhases), "plaster");
  assert.equal(suggestForecastPhaseId("Waterproofing", currentBoardPhases), "wet");
  assert.equal(suggestForecastPhaseId("Tiling", currentBoardPhases), "wet");
  assert.equal(suggestForecastPhaseId("Electrical", currentBoardPhases), "rough");
  assert.equal(suggestForecastPhaseId("Glazing", currentBoardPhases), "fitoff");
  assert.equal(suggestForecastPhaseId("Floor Coverings", currentBoardPhases), "fitoff");
  assert.equal(suggestForecastPhaseId("Joinery", currentBoardPhases), "fitoff");
  assert.equal(suggestForecastPhaseId("Stone", currentBoardPhases), "fitoff");
  assert.equal(suggestForecastPhaseId("Painting", currentBoardPhases), "fitoff");
  assert.equal(suggestForecastPhaseId("Handover & Completion", currentBoardPhases), "handover");

  // The word "External" in a demolition phase is not an external-works phase.
  assert.equal(suggestForecastPhaseId("External / Landscaping", currentBoardPhases), null);
  assert.equal(suggestForecastPhaseId("Framing / Carpentry", currentBoardPhases), null);
});
