// Avatar feature fields shared by the shop (app.js) and the Manage page (admin.js).
// Each one is a dropdown on the Manage page and a row in the Details window.
const YES_NO = [["yes", "Yes"], ["no", "No"]];
const RANKS = [["excellent", "Excellent"], ["good", "Good"], ["medium", "Medium"], ["poor", "Poor"], ["verypoor", "Very Poor"]];
window.AVATAR_FIELDS = [
  { key: "optimized", label: "Optimization", options: [["yes", "Optimized"], ["no", "Not optimized"]], badge: { yes: ["Optimized", "ok"] } },
  { key: "perfPC", label: "Performance rank (PC)", options: RANKS, rank: true },
  { key: "perfQuest", label: "Performance rank (Quest)", options: RANKS, rank: true },
  { key: "fbt", label: "Full-body tracking (FBT)", options: [["yes", "Yes"], ["partial", "Partial"], ["no", "No"]], badge: { yes: ["FBT", "info"], partial: ["FBT (partial)", "info"] } },
  { key: "audiolink", label: "AudioLink", options: YES_NO, badge: { yes: ["AudioLink", "accent"] } },
  { key: "physbones", label: "PhysBones", options: YES_NO },
  { key: "faceTracking", label: "Face tracking", options: YES_NO, badge: { yes: ["Face tracking", "info"] } },
  { key: "eyeTracking", label: "Eye tracking", options: YES_NO },
  { key: "visemes", label: "Lip sync (visemes)", options: YES_NO },
  { key: "gestures", label: "Hand gesture expressions", options: YES_NO },
  { key: "toggles", label: "Outfit / prop toggles", options: YES_NO },
  { key: "customizable", label: "Customizable (sliders, colors)", options: YES_NO },
  { key: "contacts", label: "Contacts (headpats, boops)", options: YES_NO },
  { key: "gogoloco", label: "GoGo Loco", options: YES_NO },
  { key: "vrcfury", label: "VRCFury", options: YES_NO },
];
window.RANK_TONE = { excellent: "ok", good: "ok", medium: "warn", poor: "bad", verypoor: "bad" };
window.fieldValueLabel = (f, v) => (f.options.find(([k]) => k === v) || [])[1] || null;
