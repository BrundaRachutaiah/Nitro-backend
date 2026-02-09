// utils/date.utils.js

const buildDateRange = ({ preset, from, to }) => {
  const now = new Date();

  if (preset === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { from: start, to: now };
  }

  if (preset === 'yesterday') {
    const start = new Date();
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    return { from: start, to: end };
  }

  if (preset === 'last7days') {
    return {
      from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      to: now
    };
  }

  if (preset === 'last30days') {
    return {
      from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      to: now
    };
  }

  if (from || to) {
    return {
      from: from ? new Date(from) : new Date('1970-01-01'),
      to: to ? new Date(to) : now
    };
  }

  return null; // all-time
};

const applyDateFilter = (query, range) => {
  if (!range) return query;

  return query
    .gte('created_at', range.from.toISOString())
    .lte('created_at', range.to.toISOString());
};

module.exports = {
  buildDateRange,
  applyDateFilter
};
