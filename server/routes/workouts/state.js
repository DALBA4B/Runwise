// Shared mutable state for anomaly column detection.
// If DB doesn't have anomaly columns yet, this flag is flipped to false
// and all modules stop requesting those columns.
const state = {
  hasAnomalyColumns: true
};

module.exports = state;
