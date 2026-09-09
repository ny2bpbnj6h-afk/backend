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

const role = Joi.string().valid('seeker', 'owner').required().messages({
  'any.only': 'Role must be seeker or owner',
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
