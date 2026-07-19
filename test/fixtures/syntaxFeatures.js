async function work(items) {
  let count = 0;
  const cache = {};
  try {
    for (const item of items) {
      count += 1;
      await item.load();
    }
    if (count === 0) {
      throw new Error('empty');
    }
  } catch (error) {
    throw error;
  }
  return count;
}
