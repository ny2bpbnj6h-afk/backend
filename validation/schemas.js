import Joi from 'joi'

// Shared field rules — keep in sync with the frontend forms.
const name = Joi.string().trim().min(2).max(120).required().messages({
  'string.empty': 'Name is required',
  'string.min': 'Name must be at least 2 characters',
  'any.required': 'Name is required',
})

const email = Joi.string()
  .trim()
  .lowercase()
  .email({ tlds: false })
  .max(190)
  .required()
  .messages({
    'string.empty': 'Email is required',
    'string.email': 'Enter a valid email address',
    'any.required': 'Email is required',
  })

const phone = Joi.string().trim().max(40).allow('').default('')

// Password policy: 5+ chars, at least one letter and one digit.
const password = Joi.string()
  .min(5)
  .max(128)
  .pattern(/^(?=.*[A-Za-z])(?=.*\d)/)
  .required()
  .messages({
    'string.empty': 'Password is required',
    'string.min': 'Password must be at least 5 characters',
    'string.pattern.base': 'Password must include at least one letter and one number',
    'any.required': 'Password is required',
  })

const role = Joi.string().valid('seeker', 'owner', 'agent').required().messages({
  'any.only': 'Role must be seeker, owner (landlord) or agent',
  'any.required': 'Role is required',
})

export const signupSchema = Joi.object({
  name,
  email,
  phone,
  password,
  role,
  preferredArea: Joi.string().trim().max(190).allow('').default(''),
  portfolio: Joi.string().trim().max(190).allow('').default(''),
}).options({ abortEarly: false, stripUnknown: true })

export const loginSchema = Joi.object({
  email,
  password: Joi.string().required().messages({
    'string.empty': 'Password is required',
    'any.required': 'Password is required',
  }),
}).options({ abortEarly: false, stripUnknown: true })

// Forgot password: identifier is an email OR a phone number.
export const forgotPasswordSchema = Joi.object({
  identifier: Joi.string().trim().min(3).max(190).required().messages({
    'string.empty': 'Enter your email or phone number',
    'string.min': 'Enter your email or phone number',
    'any.required': 'Enter your email or phone number',
  }),
}).options({ abortEarly: false, stripUnknown: true })

// Reset password: 6-digit code + the new password.
export const resetPasswordSchema = Joi.object({
  identifier: Joi.string().trim().min(3).max(190).required().messages({
    'string.empty': 'Enter your email or phone number',
    'any.required': 'Enter your email or phone number',
  }),
  code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({
    'string.pattern.base': 'Enter the 6-digit code',
    'any.required': 'Enter the 6-digit code',
  }),
  password,
}).options({ abortEarly: false, stripUnknown: true })

export const signup = signupSchema
export const login = loginSchema
export const forgotPassword = forgotPasswordSchema
export const resetPassword = resetPasswordSchema

// Social sign-in: client sends the provider's ID token; the server verifies
// it. verifiedProfile is only honored when SOCIAL_ALLOW_UNVERIFIED=true (dev).
export const socialLoginSchema = Joi.object({
  provider: Joi.string().valid('google', 'apple').required(),
  idToken: Joi.string().min(20).max(4096).allow('').default(''),
  verifiedProfile: Joi.object({
    email: Joi.string().trim().lowercase().email({ tlds: false }).required(),
    name: Joi.string().trim().max(120).allow(''),
    sub: Joi.string().trim().max(190).allow(''),
    id: Joi.string().trim().max(190).allow(''),
  })
    .unknown(true)
    .optional(),
}).options({ abortEarly: false, stripUnknown: true })
export const socialLogin = socialLoginSchema

// ---- Properties / applications / viewings ----

// Owner creating a listing.
export const propertyCreateSchema = Joi.object({
  title: Joi.string().trim().min(3).max(190).required().messages({
    'string.empty': 'Title is required',
    'string.min': 'Title must be at least 3 characters',
    'any.required': 'Title is required',
  }),
  description: Joi.string().trim().max(5000).allow('', null).default(''),
  area: Joi.string().trim().min(2).max(190).required().messages({
    'string.empty': 'Area is required',
    'any.required': 'Area is required',
  }),
  purpose: Joi.string().valid('rent', 'sale').default('rent'),
  propertyType: Joi.string()
    .valid('apartment', 'condo', 'townhouse', 'house', 'serviced_apartment')
    .default('apartment'),
  rentAmount: Joi.number().precision(2).min(0).max(99_999_999).default(0),
  rentPeriod: Joi.string().valid('month', 'year').default('month'),
  saleAmount: Joi.number().precision(2).min(0).max(99_999_999_99).allow(null).default(null),
  bedrooms: Joi.number().integer().min(0).max(50).default(1),
  bathrooms: Joi.number().integer().min(0).max(50).default(1),
  sizeM2: Joi.number().integer().min(0).max(100000).default(0),
  furnished: Joi.string().valid('any', 'furnished', 'unfurnished').default('any'),
  videoUrl: Joi.string().trim().uri({ allowRelative: false }).max(500).allow('').default(''),
  tourUrl: Joi.string().trim().uri({ allowRelative: false }).max(500).allow('').default(''),
  agentId: Joi.number().integer().positive().allow(null).default(null),
  images: Joi.array()
    .items(Joi.string().trim().max(500))
    .max(15)
    .default([]),
})
  .custom((value, helpers) => {
    const price = value.purpose === 'sale' ? value.saleAmount : value.rentAmount
    if (!price || price <= 0) {
      return helpers.error('any.custom', {
        message:
          value.purpose === 'sale'
            ? 'Sale price is required for listings for sale'
            : 'Monthly rent is required for rental listings',
      })
    }
    return value
  })
  .options({ abortEarly: false, stripUnknown: true })

// Tenant applying to a property.
export const applySchema = Joi.object({
  message: Joi.string().trim().max(2000).allow('').default(''),
}).options({ abortEarly: false, stripUnknown: true })

// Tenant scheduling a viewing.
export const scheduleSchema = Joi.object({
  scheduledFor: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/)
    .required()
    .messages({
      'string.pattern.base': 'scheduledFor must be YYYY-MM-DD HH:MM (24h)',
      'any.required': 'Pick a date and time for the viewing',
    }),
}).options({ abortEarly: false, stripUnknown: true })

export const propertyCreate = propertyCreateSchema
export const apply = applySchema
export const schedule = scheduleSchema

// Contact-form lead capture (public — rate-limited at the route level).
export const contactMessageSchema = Joi.object({
  name,
  email,
  phone: Joi.string().trim().max(40).allow('').default(''),
  role: Joi.string()
    .trim()
    .valid('Tenant', 'Landlord', 'Tenant and Landlord', 'Other')
    .default('Other'),
  message: Joi.string().trim().min(5).max(3000).required().messages({
    'string.empty': 'Message is required',
    'string.min': 'Message must be at least 5 characters',
    'any.required': 'Message is required',
  }),
  source: Joi.string().trim().max(60).allow('').default('contact_page'),
}).options({ abortEarly: false, stripUnknown: true })
