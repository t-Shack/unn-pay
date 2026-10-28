'use strict';

module.exports = async () => {
  if (globalThis.__UNN_PG__) await globalThis.__UNN_PG__.stop();
};
