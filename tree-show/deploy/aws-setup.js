#!/usr/bin/env node
'use strict';
// Sets up (or updates) the guest site on AWS, everything in us-east-1:
//   https://<site>  ->  CloudFront  ->  S3 (the page, private, read by CloudFront only)
//                                    ->  /api/*  ->  Lambda function URL (the queue)  ->  DynamoDB (one table)
// plus its HTTPS certificate (ACM, checked through Route53) and the DNS record (Route53 alias).
// Safe to run again: it finds what exists and only creates what's missing; the page and the function code are updated.
//
//   AWS_PROFILE=treemote node deploy/aws-setup.js <site name, e.g. t.example.com>
//
// Needs the AWS CLI (aws) and a key with deploy/treemote-iam-policy.json. Secrets (the tree's key, CloudFront's
// origin key, the address salt) are made once and kept in ~/.config/treemote/state.json (only you can read it).
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const SITE = String(process.argv[2] || '').toLowerCase();
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(SITE)) { console.error('Usage: node deploy/aws-setup.js <site name, e.g. t.example.com>'); process.exit(1); }
const REGION = 'us-east-1', N = 'treemote', ROOT = path.join(__dirname, '..');
const AWS = process.env.AWS_CLI || (fs.existsSync(path.join(os.homedir(), '.local/bin/aws')) ? path.join(os.homedir(), '.local/bin/aws') : 'aws');
const STATE_DIR = path.join(os.homedir(), '.config', 'treemote'), STATE = path.join(STATE_DIR, 'state.json');
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1), { mode: 0o600 });
const say = (...a) => console.log('·', ...a);

function aws(args, opts = {}) {
  try {
    const out = execFileSync(AWS, [...args, '--region', opts.region || REGION, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    return out.trim() ? JSON.parse(out) : {};
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (opts.ok && opts.ok.some((s) => msg.includes(s))) return null;
    throw new Error(`aws ${args.slice(0, 2).join(' ')}: ${msg.trim().split('\n').pop()}`);
  }
}
const sleep = (s) => execFileSync('sleep', [String(s)]);
const tmp = (name, data) => { const f = path.join(os.tmpdir(), `${N}-${process.pid}-${name}`); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };
const secret = () => crypto.randomBytes(24).toString('base64url');

const ACCOUNT = aws(['sts', 'get-caller-identity']).Account;
say(`Account ${ACCOUNT.slice(0, 4)}…, region ${REGION}, site ${SITE}`);
st.site = SITE; st.treeKey = st.treeKey || secret(); st.originKey = st.originKey || secret(); st.salt = st.salt || secret(); save();

// ---------- 1. the table ----------
const TABLE = `${N}-queue`;
if (!aws(['dynamodb', 'describe-table', '--table-name', TABLE], { ok: ['ResourceNotFoundException'] })) {
  say('Creating the table', TABLE);
  aws(['dynamodb', 'create-table', '--table-name', TABLE, '--attribute-definitions', 'AttributeName=k,AttributeType=S', '--key-schema', 'AttributeName=k,KeyType=HASH', '--billing-mode', 'PAY_PER_REQUEST', '--tags', `Key=app,Value=${N}`]);
  aws(['dynamodb', 'wait', 'table-exists', '--table-name', TABLE]);
} else say('Table', TABLE, 'is there');
const TABLE_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE}`;

// ---------- 2. the function's role: read/write that table, write its own logs ----------
const ROLE = `${N}-fn-role`;
let role = aws(['iam', 'get-role', '--role-name', ROLE], { ok: ['NoSuchEntity'] });
if (!role) {
  say('Creating the role', ROLE);
  role = aws(['iam', 'create-role', '--role-name', ROLE, '--tags', `Key=app,Value=${N}`, '--assume-role-policy-document', 'file://' + tmp('trust.json', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] })]);
  sleep(10); // new roles take a moment to be usable
}
aws(['iam', 'put-role-policy', '--role-name', ROLE, '--policy-name', `${N}-fn`, '--policy-document', 'file://' + tmp('fn.json', { Version: '2012-10-17', Statement: [
  { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: TABLE_ARN },
  { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${N}-*` }] })]);

// ---------- 3. the function (the same queue code as tree-show's /external sample) ----------
const FN = `${N}-api`;
const zip = path.join(os.tmpdir(), `${N}-${process.pid}.zip`);
execFileSync('python3', ['-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor f in sys.argv[2:]: z.write(f,os.path.basename(f))\nz.close()',
  zip, path.join(ROOT, 'guestcloud/index.mjs'), path.join(ROOT, 'guestcloud/words.mjs')]); // (no zip program needed)
const env = 'Variables={' + [['TABLE', TABLE], ['TREE_KEY', st.treeKey], ['ORIGIN_KEY', st.originKey], ['SALT', st.salt]].map(([k, v]) => `${k}=${v}`).join(',') + '}';
let fn = aws(['lambda', 'get-function', '--function-name', FN], { ok: ['ResourceNotFoundException'] });
if (!fn) {
  say('Creating the function', FN);
  for (let i = 0; ; i++) { // the role may still be settling
    try { aws(['lambda', 'create-function', '--function-name', FN, '--runtime', 'nodejs22.x', '--handler', 'index.handler', '--role', role.Role.Arn, '--zip-file', 'fileb://' + zip, '--memory-size', '256', '--timeout', '10', '--environment', env, '--tags', `app=${N}`]); break; }
    catch (e) { if (i > 5 || !/role|assume/i.test(e.message)) throw e; sleep(8); }
  }
} else {
  say('Updating the function code');
  aws(['lambda', 'update-function-code', '--function-name', FN, '--zip-file', 'fileb://' + zip]);
  aws(['lambda', 'wait', 'function-updated', '--function-name', FN]);
  aws(['lambda', 'update-function-configuration', '--function-name', FN, '--environment', env]);
}
aws(['lambda', 'wait', 'function-active', '--function-name', FN]);
aws(['lambda', 'wait', 'function-updated', '--function-name', FN]);
fs.unlinkSync(zip);
let url = aws(['lambda', 'get-function-url-config', '--function-name', FN], { ok: ['ResourceNotFoundException'] });
if (!url) {
  say('Giving the function its URL (only CloudFront knows the key that it checks)');
  url = aws(['lambda', 'create-function-url-config', '--function-name', FN, '--auth-type', 'NONE']);
  aws(['lambda', 'add-permission', '--function-name', FN, '--statement-id', 'public-url', '--action', 'lambda:InvokeFunctionUrl', '--principal', '*', '--function-url-auth-type', 'NONE'], { ok: ['ResourceConflictException'] });
  aws(['lambda', 'add-permission', '--function-name', FN, '--statement-id', 'public-url-invoke', '--action', 'lambda:InvokeFunction', '--principal', '*', '--invoked-via-function-url'], { ok: ['ResourceConflictException', 'Unknown options', 'invoked-via-function-url'] });
}
const FN_HOST = new URL(url.FunctionUrl).host;

// ---------- 4. the page: a private bucket ----------
const BUCKET = st.bucket || `${N}-site-${crypto.createHash('sha256').update(ACCOUNT + SITE).digest('hex').slice(0, 10)}`;
if (!aws(['s3api', 'head-bucket', '--bucket', BUCKET], { ok: ['404', 'Not Found', 'NoSuchBucket'] })) {
  say('Creating the bucket', BUCKET);
  aws(['s3api', 'create-bucket', '--bucket', BUCKET]);
  aws(['s3api', 'put-public-access-block', '--bucket', BUCKET, '--public-access-block-configuration', 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true']);
}
st.bucket = BUCKET; save();
const files = [['index.html', 'guestcloud/site/index.html', 'text/html; charset=utf-8', 'no-cache'], ['engine.js', 'public/engine.js', 'text/javascript; charset=utf-8', 'public, max-age=300'],
  ['guestlook.js', 'public/guestlook.js', 'text/javascript; charset=utf-8', 'public, max-age=300'], ['icon.svg', 'public/icon.svg', 'image/svg+xml', 'public, max-age=86400'],
  ['apple-touch-icon.png', 'guestcloud/site/apple-touch-icon.png', 'image/png', 'public, max-age=86400']];
for (const [key, src, type, cache] of files) aws(['s3api', 'put-object', '--bucket', BUCKET, '--key', key, '--body', path.join(ROOT, src), '--content-type', type, '--cache-control', cache]);
say('Page files uploaded');

// ---------- 5. the HTTPS certificate, checked through Route53 ----------
const ZONE = aws(['route53', 'list-hosted-zones-by-name', '--dns-name', SITE.split('.').slice(-2).join('.')]).HostedZones.find((z) => SITE.endsWith(z.Name.replace(/\.$/, '')));
if (!ZONE) throw new Error('No Route53 zone found for ' + SITE);
const ZONE_ID = ZONE.Id.split('/').pop();
let certArn = (aws(['acm', 'list-certificates', '--certificate-statuses', 'ISSUED', 'PENDING_VALIDATION']).CertificateSummaryList || []).find((c) => c.DomainName === SITE);
certArn = certArn ? certArn.CertificateArn : null;
if (!certArn) { say('Requesting the certificate for', SITE); certArn = aws(['acm', 'request-certificate', '--domain-name', SITE, '--validation-method', 'DNS', '--tags', `Key=app,Value=${N}`]).CertificateArn; }
let cert;
for (let i = 0; i < 20; i++) { cert = aws(['acm', 'describe-certificate', '--certificate-arn', certArn]).Certificate; if (cert.DomainValidationOptions && cert.DomainValidationOptions[0].ResourceRecord) break; sleep(3); }
if (cert.Status !== 'ISSUED') {
  const rr = cert.DomainValidationOptions[0].ResourceRecord;
  say('Adding the certificate check to DNS and waiting for it (a few minutes)…');
  aws(['route53', 'change-resource-record-sets', '--hosted-zone-id', ZONE_ID, '--change-batch', 'file://' + tmp('acm.json', { Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: rr.Name, Type: rr.Type, TTL: 300, ResourceRecords: [{ Value: rr.Value }] } }] })]);
  aws(['acm', 'wait', 'certificate-validated', '--certificate-arn', certArn]);
}
say('Certificate issued');

// ---------- 6. CloudFront: the page from the bucket, /api/* to the function ----------
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6', CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
let oac = (aws(['cloudfront', 'list-origin-access-controls']).OriginAccessControlList.Items || []).find((o) => o.Name === `${N}-s3`);
if (!oac) oac = aws(['cloudfront', 'create-origin-access-control', '--origin-access-control-config', `Name=${N}-s3,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3`]).OriginAccessControl;
let dist = (aws(['cloudfront', 'list-distributions']).DistributionList.Items || []).find((d) => (d.Aliases.Items || []).includes(SITE));
if (!dist) {
  say('Creating the CloudFront distribution');
  const cfg = {
    CallerReference: `${N}-${Date.now()}`, Comment: `${N} guest site`, Enabled: true, Aliases: { Quantity: 1, Items: [SITE] }, DefaultRootObject: 'index.html',
    PriceClass: 'PriceClass_100', HttpVersion: 'http2and3', IsIPV6Enabled: true,
    ViewerCertificate: { ACMCertificateArn: certArn, SSLSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
    Origins: { Quantity: 2, Items: [
      { Id: 's3', DomainName: `${BUCKET}.s3.${REGION}.amazonaws.com`, OriginAccessControlId: oac.Id, S3OriginConfig: { OriginAccessIdentity: '' } },
      { Id: 'api', DomainName: FN_HOST, CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'https-only', OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] } },
        CustomHeaders: { Quantity: 1, Items: [{ HeaderName: 'x-origin-key', HeaderValue: st.originKey }] } }] },
    DefaultCacheBehavior: { TargetOriginId: 's3', ViewerProtocolPolicy: 'redirect-to-https', CachePolicyId: CACHING_OPTIMIZED, Compress: true,
      AllowedMethods: { Quantity: 2, Items: ['GET', 'HEAD'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } } },
    CacheBehaviors: { Quantity: 1, Items: [{ PathPattern: '/api/*', TargetOriginId: 'api', ViewerProtocolPolicy: 'redirect-to-https', CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST, Compress: true,
      AllowedMethods: { Quantity: 7, Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } } }] },
  };
  dist = aws(['cloudfront', 'create-distribution', '--distribution-config', 'file://' + tmp('cf.json', cfg)]).Distribution;
} else {
  say('CloudFront distribution is there; refreshing the page');
  aws(['cloudfront', 'create-invalidation', '--distribution-id', dist.Id, '--paths', '/index.html', '/engine.js', '/guestlook.js', '/']);
}
st.distribution = dist.Id; save();
const DIST_ARN = `arn:aws:cloudfront::${ACCOUNT}:distribution/${dist.Id}`;
aws(['s3api', 'put-bucket-policy', '--bucket', BUCKET, '--policy', 'file://' + tmp('bucket.json', { Version: '2012-10-17', Statement: [{ Sid: 'CloudFrontReadsThePage', Effect: 'Allow',
  Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${BUCKET}/*`, Condition: { StringEquals: { 'AWS:SourceArn': DIST_ARN } } }] })]);

// ---------- 7. the DNS record ----------
const alias = (type) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: SITE, Type: type, AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: dist.DomainName, EvaluateTargetHealth: false } } });
aws(['route53', 'change-resource-record-sets', '--hosted-zone-id', ZONE_ID, '--change-batch', 'file://' + tmp('dns.json', { Changes: [alias('A'), alias('AAAA')] })]);
say(`DNS: ${SITE} -> CloudFront`);
for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`${N}-${process.pid}-`)) fs.unlinkSync(path.join(os.tmpdir(), f));
say(`Done. It can take 5-15 minutes for a new CloudFront distribution to answer. Then: https://${SITE}`);
say(`For tree-show (Settings -> Guests): site address https://${SITE}, key in ${STATE} ("treeKey").`);
