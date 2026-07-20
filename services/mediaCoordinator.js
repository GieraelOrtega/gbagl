let mediaQueue = Promise.resolve();

function withMediaOperation(work) {
  const operation = mediaQueue.then(work, work);
  mediaQueue = operation.catch(() => {});
  return operation;
}

module.exports = { withMediaOperation };
