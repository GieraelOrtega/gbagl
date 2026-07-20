async function toggleVote(pool, itemId, voterSlot, vote) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT vote FROM bucket_votes
       WHERE item_id = ? AND voter_slot = ? FOR UPDATE`,
      [itemId, voterSlot],
    );
    if (rows[0]?.vote === vote) {
      await connection.execute(
        'DELETE FROM bucket_votes WHERE item_id = ? AND voter_slot = ?',
        [itemId, voterSlot],
      );
      await connection.commit();
      return null;
    }
    await connection.execute(
      `INSERT INTO bucket_votes (item_id, voter_slot, vote) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE vote = VALUES(vote)`,
      [itemId, voterSlot, vote],
    );
    await connection.commit();
    return vote;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { toggleVote };
