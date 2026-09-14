const { DateTime, Interval } = require("luxon")

function daysRequested(request) {
  const start = DateTime.fromISO(request.startDate)
  const end = DateTime.fromISO(request.endDate)
  return Interval.fromDateTimes(start, end).count("days")
}

module.exports = { daysRequested }
