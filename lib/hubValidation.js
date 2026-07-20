const path = require('path');
const { isoDate, positiveId, text } = require('./validation');

const BUCKET_CATEGORIES = ['travel', 'experience', 'food', 'home', 'growth', 'other'];
const VOTER_SLOTS = ['partner_one', 'partner_two'];
const VOTE_VALUES = ['yes', 'maybe', 'not_yet'];
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function optionalDate(value, name) {
  return isoDate(value, name, { required: false });
}

function booleanField(value) {
  return value === true || value === '1' || value === 'on' || value === 'true';
}

function enumValue(value, name, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function displayOrder(value) {
  const order = Number.parseInt(value || '0', 10);
  if (!Number.isInteger(order) || order < 0 || order > 100000) {
    throw new Error('Display order must be between 0 and 100000');
  }
  return order;
}

function optionalId(value, name) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return positiveId(String(value));
  } catch {
    throw new Error(`${name} is invalid`);
  }
}

function dateTimeLocal(value, name) {
  const normalized = text(value, name, 16);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    throw new Error(`${name} must include a valid date and time`);
  }
  const [date, time] = normalized.split('T');
  isoDate(date, name);
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error(`${name} is not a valid time`);
  return normalized;
}

function validateBucketItem(body) {
  return {
    title: text(body.title, 'Title', 150),
    description: text(body.description, 'Description', 4000),
    category: enumValue(body.category, 'Category', BUCKET_CATEGORIES),
    targetDate: optionalDate(body.target_date, 'Target date'),
  };
}

function validateBucketMemory(body) {
  return text(body.memory, 'Memory', 8000, { required: false });
}

function validateVote(body) {
  return {
    voterSlot: enumValue(body.voter_slot, 'Voter', VOTER_SLOTS),
    vote: enumValue(body.vote, 'Vote', VOTE_VALUES),
  };
}

function validateEvent(body) {
  const eventAt = dateTimeLocal(body.event_at, 'Event time');
  const reminderAt = body.reminder_at
    ? dateTimeLocal(body.reminder_at, 'Reminder time')
    : null;
  if (reminderAt && reminderAt > eventAt) {
    throw new Error('Reminder time must not be after the event');
  }
  return {
    title: text(body.title, 'Title', 150),
    eventAt,
    reminderAt,
    notes: text(body.notes, 'Notes', 4000, { required: false }),
    isCompleted: booleanField(body.is_completed),
  };
}

function validateAlbum(body) {
  return {
    title: text(body.title, 'Title', 150),
    description: text(body.description, 'Description', 4000),
    albumDate: optionalDate(body.album_date, 'Album date'),
    displayOrder: displayOrder(body.display_order),
  };
}

function validatePhoto(body) {
  return {
    albumId: positiveId(String(body.album_id)),
    milestoneId: optionalId(body.milestone_id, 'Timeline milestone'),
    caption: text(body.caption, 'Caption', 1000, { required: false }),
    photoDate: optionalDate(body.photo_date, 'Photo date'),
    displayOrder: displayOrder(body.display_order),
  };
}

function existingImageName(value) {
  const supplied = text(value, 'Existing image', 255);
  const candidate = supplied.replace(/^\/?images\//, '');
  if (
    path.basename(candidate) !== candidate
    || candidate.includes('\\')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(candidate)
  ) {
    throw new Error('Existing image must be a JPEG, PNG, or WebP basename from public/images');
  }
  return candidate;
}

function validateJournal(body) {
  return {
    milestoneId: optionalId(body.milestone_id, 'Timeline milestone'),
    title: text(body.title, 'Title', 150),
    body: text(body.body, 'Journal body', 20000),
    entryDate: isoDate(body.entry_date, 'Entry date'),
  };
}

module.exports = {
  ALLOWED_MEDIA_TYPES,
  BUCKET_CATEGORIES,
  VOTER_SLOTS,
  VOTE_VALUES,
  booleanField,
  dateTimeLocal,
  existingImageName,
  validateAlbum,
  validateBucketItem,
  validateBucketMemory,
  validateEvent,
  validateJournal,
  validatePhoto,
  validateVote,
};
