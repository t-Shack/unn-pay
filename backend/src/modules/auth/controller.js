'use strict';

const service = require('./service');
const asyncHandler = require('../../middleware/asyncHandler');

/**
 * Controllers hold no business logic (§4). They read the validated request,
 * call one service function, and shape the HTTP response.
 */

const requestContext = (req) => ({
  userAgent: req.get('user-agent'),
  ipAddress: req.ip,
});

exports.activateRequest = asyncHandler(async (req, res) => {
  const result = await service.requestActivation({
    matricNumber: req.body.matric_number,
    ipAddress: req.ip,
  });
  res.status(202).json(result);
});

exports.activateConfirm = asyncHandler(async (req, res) => {
  const result = await service.confirmActivation({
    matricNumber: req.body.matric_number,
    code: req.body.code,
    password: req.body.password,
    ...requestContext(req),
  });
  res.status(200).json(result);
});

exports.login = asyncHandler(async (req, res) => {
  const result = await service.login({
    matricNumber: req.body.matric_number,
    password: req.body.password,
    ...requestContext(req),
  });
  res.status(200).json(result);
});

exports.refresh = asyncHandler(async (req, res) => {
  const tokens = await service.refresh({
    refreshToken: req.body.refresh_token,
    ...requestContext(req),
  });
  res.status(200).json({ tokens });
});

exports.logout = asyncHandler(async (req, res) => {
  await service.logout({ refreshToken: req.body.refresh_token });
  res.status(200).json({ message: 'Signed out' });
});

exports.forgotPassword = asyncHandler(async (req, res) => {
  const result = await service.forgotPassword({ matricNumber: req.body.matric_number });
  res.status(202).json(result);
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const result = await service.resetPassword({
    matricNumber: req.body.matric_number,
    code: req.body.code,
    password: req.body.password,
    ipAddress: req.ip,
  });
  res.status(200).json(result);
});

exports.me = asyncHandler(async (req, res) => {
  res.status(200).json({ student: req.student.toPublicJSON() });
});
