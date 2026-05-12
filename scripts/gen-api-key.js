#!/usr/bin/env node
const crypto = require("crypto");
process.stdout.write(crypto.randomBytes(32).toString("base64url") + "\n");
