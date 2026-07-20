function text(value, name, maximum, { required = true } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (required && !normalized) throw new Error(`${name} is required`);
  if (normalized.length > maximum) throw new Error(`${name} is too long`);
  return normalized;
}

function positiveId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(value)) {
    throw new Error('Invalid record ID');
  }
  return id;
}

function isoDate(value, name) {
  const date = text(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${name} must use YYYY-MM-DD`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${name} is not a valid date`);
  }
  return date;
}

function timezone(value) {
  const zone = text(value, 'Timezone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    throw new Error('Timezone must be a valid IANA timezone');
  }
  return zone;
}

function imagePath(value) {
  const image = text(value, 'Image path', 255, { required: false });
  if (!image) return null;
  if (
    image.includes('..')
    || image.startsWith('/')
    || image.includes('\\')
    || !/^images\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(image)
  ) {
    throw new Error('Image path must point inside images/ and use a supported image extension');
  }
  return image;
}

function optionalUrl(value) {
  const url = text(value, 'URL', 1000, { required: false });
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL must be a valid web address');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use HTTP or HTTPS');
  }
  return parsed.toString();
}

function validateSettings(body) {
  return {
    partner_one_name: text(body.partner_one_name, 'First partner name', 80),
    partner_two_name: text(body.partner_two_name, 'Second partner name', 80),
    anniversary_date: isoDate(body.anniversary_date, 'Anniversary date'),
    timezone: timezone(body.timezone),
  };
}

function validateMilestone(body) {
  const displayOrder = Number.parseInt(body.display_order, 10);
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 100000) {
    throw new Error('Display order must be between 0 and 100000');
  }
  return {
    displayOrder,
    date: text(body.date, 'Date label', 100),
    title: text(body.title, 'Title', 150),
    description: text(body.description, 'Description', 2000),
    emoji: text(body.emoji, 'Emoji', 32),
    photo: imagePath(body.photo),
    linkUrl: optionalUrl(body.link_url),
  };
}

module.exports = {
  imagePath,
  isoDate,
  optionalUrl,
  positiveId,
  timezone,
  validateMilestone,
  validateSettings,
};
