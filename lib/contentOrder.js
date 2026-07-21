const { positiveId } = require('./validation');

const COLLECTIONS = Object.freeze({
  adventures: Object.freeze({ table: 'date_ideas' }),
  albums: Object.freeze({ table: 'photo_albums' }),
  bucket: Object.freeze({ table: 'bucket_items' }),
  events: Object.freeze({ table: 'shared_events' }),
  journal: Object.freeze({ table: 'journal_entries' }),
  photos: Object.freeze({ table: 'album_photos', scopeColumn: 'album_id' }),
  timeline: Object.freeze({ table: 'timeline_milestones' }),
});

function clientOrderError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function collectionDefinition(collection) {
  const definition = COLLECTIONS[collection];
  if (!definition) throw new Error('Unsupported content collection');
  return definition;
}

function orderedIds(value) {
  if (!Array.isArray(value)) throw clientOrderError('Order must be a list of items');
  let ids;
  try {
    ids = value.map((item) => positiveId(String(item)));
  } catch {
    throw clientOrderError('Order contains an invalid item');
  }
  if (new Set(ids).size !== ids.length) {
    throw clientOrderError('Order contains duplicate items');
  }
  return ids;
}

function scopeValues(definition, scopeId) {
  if (!definition.scopeColumn) return { clause: '', params: [], scopeId: null };
  let id;
  try {
    id = positiveId(String(scopeId));
  } catch {
    throw clientOrderError('Order has an invalid content scope');
  }
  return {
    clause: ` WHERE ${definition.scopeColumn} = ?`,
    params: [id],
    scopeId: id,
  };
}

async function nextDisplayOrder(databasePool, collection, scopeId = null) {
  const definition = collectionDefinition(collection);
  const scope = scopeValues(definition, scopeId);
  const [rows] = await databasePool.execute(
    `SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
     FROM ${definition.table}${scope.clause}`,
    scope.params,
  );
  const nextOrder = Number(rows[0]?.next_order);
  if (!Number.isSafeInteger(nextOrder) || nextOrder < 0) {
    throw new Error('Could not determine the next display order');
  }
  return nextOrder;
}

async function reorderCollection(databasePool, collection, value, scopeId = null) {
  const definition = collectionDefinition(collection);
  const ids = orderedIds(value);
  const scope = scopeValues(definition, scopeId);
  const connection = await databasePool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.execute(
      `SELECT id FROM ${definition.table}${scope.clause} ORDER BY id FOR UPDATE`,
      scope.params,
    );
    const existingIds = rows.map((row) => Number(row.id)).sort((left, right) => left - right);
    const suppliedIds = [...ids].sort((left, right) => left - right);
    if (
      existingIds.length !== suppliedIds.length
      || existingIds.some((id, index) => id !== suppliedIds[index])
    ) {
      throw clientOrderError(
        'Content changed while reordering. Refresh and try again.',
        409,
      );
    }

    for (const [displayOrder, id] of ids.entries()) {
      const params = [displayOrder, id];
      let where = 'id = ?';
      if (definition.scopeColumn) {
        where += ` AND ${definition.scopeColumn} = ?`;
        params.push(scope.scopeId);
      }
      await connection.execute(
        `UPDATE ${definition.table} SET display_order = ? WHERE ${where}`,
        params,
      );
    }
    await connection.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Content reorder rollback failed:', rollbackError.message);
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

function publicOrderError(error) {
  const status = Number(error?.statusCode);
  if (status === 400 || status === 409) {
    return { status, message: error.message };
  }
  return { status: 500, message: 'Order could not be saved' };
}

module.exports = {
  COLLECTIONS,
  nextDisplayOrder,
  orderedIds,
  publicOrderError,
  reorderCollection,
};
