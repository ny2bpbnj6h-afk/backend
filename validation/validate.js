// Reusable Joi middleware: validate(schema) validates req.body, and on
// success replaces req.body with the sanitized (trimmed, defaulted,
// unknown-stripped) value. Responses use 422 with field-level messages.
export const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body ?? {})

  if (error) {
    return res.status(422).json({
      error: error.details.map((detail) => detail.message).join('. '),
      fields: error.details.reduce((acc, detail) => {
        const key = detail.path.join('.')
        if (!acc[key]) acc[key] = detail.message
        return acc
      }, {}),
    })
  }

  req.body = value
  return next()
}

export default validate
