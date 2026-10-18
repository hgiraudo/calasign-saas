# CalaSign SaaS — entorno dev (dev.calasign.com) en la cuenta calasign-sandbox.
#
# Entorno chico de una sola máquina: la misma app que en producción, pero API + worker + Postgres en un EC2.
# Producción usa ECS Fargate + Aurora + S3 + KMS (docs/ARQUITECTURA.md §8); lo que se prueba acá con
# servicios reales es S3 (archivos) y KMS (sello de la plataforma).
#
# Costo aproximado: ~USD 18/mes (t4g.small 12 + IP pública 3,6 + disco 1,6 + KMS 1).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "aws_profile" {
  default = "bootstrap-terraform"
}
variable "account_id" {
  default = "427064006935" # calasign-sandbox
}
variable "domain" {
  default = "dev.calasign.com"
}
variable "instance_type" {
  default = "t4g.small"
}
variable "subnet_id" {
  default = "subnet-0799813ecadb417aa" # calasign-sandbox-publica-us-east-1a
}
variable "alert_email" {
  description = "Destino de las alertas operativas del entorno (hay que confirmar la suscripción desde el correo)"
  default     = "hgiraudo@gmail.com"
}

provider "aws" {
  region  = "us-east-1"
  profile = var.aws_profile
  assume_role {
    role_arn     = "arn:aws:iam::${var.account_id}:role/OrganizationAccountAccessRole"
    session_name = "terraform-calasign-saas-dev"
  }
  default_tags {
    tags = { Proyecto = "calasign-saas", Entorno = "dev", Gestion = "terraform" }
  }
}

data "aws_subnet" "public" {
  id = var.subnet_id
}

data "aws_ssm_parameter" "al2023_arm" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# ───────────── Archivos (S3) ─────────────

resource "aws_s3_bucket" "blobs" {
  bucket        = "calasign-saas-dev-${var.account_id}"
  force_destroy = true # dev: datos descartables
}

resource "aws_s3_bucket_public_access_block" "blobs" {
  bucket                  = aws_s3_bucket.blobs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "blobs" {
  bucket = aws_s3_bucket.blobs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Paquetes de deploy y backups de Postgres no se acumulan para siempre (el bucket es versionado).
# No toca los archivos de las organizaciones: su retención la maneja la aplicación.
resource "aws_s3_bucket_lifecycle_configuration" "blobs" {
  bucket = aws_s3_bucket.blobs.id

  rule {
    id     = "releases"
    status = "Enabled"
    filter {
      prefix = "releases/"
    }
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  rule {
    id     = "backups-postgres"
    status = "Enabled"
    filter {
      prefix = "backups/postgres/"
    }
    expiration {
      days = 35
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.blobs]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "blobs" {
  bucket = aws_s3_bucket.blobs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "blobs_tls" {
  bucket = aws_s3_bucket.blobs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SoloTLS"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.blobs.arn, "${aws_s3_bucket.blobs.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ───────────── Sello de plataforma (KMS) ─────────────

resource "aws_kms_key" "seal" {
  description              = "CalaSign SaaS dev - sello de plataforma (PAdES)"
  customer_master_key_spec = "RSA_3072"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 7
}

resource "aws_kms_alias" "seal" {
  name          = "alias/calasign-saas-dev-seal"
  target_key_id = aws_kms_key.seal.key_id
}

# ───────────── Secretos ─────────────

resource "random_bytes" "secret_key" {
  length = 32
}

resource "aws_ssm_parameter" "secret_key" {
  name  = "/calasign-saas/dev/SECRET_KEY"
  type  = "SecureString"
  value = random_bytes.secret_key.base64
}

# La cadena del certificado del sello la carga scripts/issue-dev-seal-cert.ts (dato público).
resource "aws_ssm_parameter" "seal_chain" {
  name  = "/calasign-saas/dev/SEAL_CHAIN_PEM"
  type  = "String"
  tier  = "Advanced"
  value = "pendiente"
  lifecycle {
    ignore_changes = [value]
  }
}

# ───────────── Cómputo ─────────────

resource "aws_iam_role" "app" {
  name = "calasign-saas-dev-app"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "app" {
  name = "app"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Archivos", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:ListBucketVersions", "s3:DeleteObject", "s3:DeleteObjectVersion"], Resource = [aws_s3_bucket.blobs.arn, "${aws_s3_bucket.blobs.arn}/*"] },
      {
        # El rol es de la instancia: lo usan la app (usuario calasign) y root (backup y deploy). Con la app
        # comprometida no se puede reemplazar un paquete de deploy (lo extrae root) ni borrar los backups, ni
        # siquiera sus versiones anteriores. Los paquetes los sube el operador con sus credenciales y la
        # expiración de ambos prefijos la hace la regla de ciclo de vida.
        Sid      = "SinTocarDeployNiBackups"
        Effect   = "Deny"
        Action   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = ["${aws_s3_bucket.blobs.arn}/releases/*", "${aws_s3_bucket.blobs.arn}/backups/*"]
      },
      { Sid = "PaquetesSoloLectura", Effect = "Deny", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.blobs.arn}/releases/*" },
      { Sid = "Sello", Effect = "Allow", Action = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"], Resource = aws_kms_key.seal.arn },
      { Sid = "Parametros", Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:us-east-1:${var.account_id}:parameter/calasign-saas/dev/*" },
      {
        # PutMetricData no admite ARN de recurso: se acota por namespace.
        Sid       = "MetricasBackup"
        Effect    = "Allow"
        Action    = ["cloudwatch:PutMetricData"]
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = local.backup_metric_namespace } }
      },
      {
        Sid       = "ClavesAdministradasPorAWS"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = ["s3.us-east-1.amazonaws.com", "ssm.us-east-1.amazonaws.com"] } }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "calasign-saas-dev-app"
  role = aws_iam_role.app.name
}

resource "aws_security_group" "app" {
  name        = "calasign-saas-dev-web"
  description = "HTTP/HTTPS publico; sin SSH (acceso por SSM)"
  vpc_id      = data.aws_subnet.public.vpc_id

  ingress {
    description = "HTTP (redireccion y desafio ACME)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023_arm.value
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/bootstrap.sh", {
    domain     = var.domain
    bucket     = aws_s3_bucket.blobs.id
    kms_key_id = aws_kms_key.seal.arn
  })
  user_data_replace_on_change = false

  tags = { Name = "calasign-saas-dev" }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = { Name = "calasign-saas-dev" }
}

# ───────────── Alertas ─────────────

locals {
  backup_metric_namespace = "CalaSign/Backup"
}

resource "aws_sns_topic" "alerts" {
  name = "calasign-saas-dev-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# calasign-backup.sh publica LastSuccess=1 en cada backup completo (diario a las 06:30 UTC y antes de cada deploy).
# Alarma si no hubo ninguno en 24 períodos horarios seguidos: CloudWatch no permite evaluar más de un día
# (EvaluationPeriods x Period <= 86400), así que es la ventana más larga posible; con el backup diario (jitter de
# 15 min) nunca hay 24 horas seguidas sin dato salvo que un backup falle. Sin datos cuenta como falla: también
# avisa si el timer deja de correr o la instancia está apagada.
resource "aws_cloudwatch_metric_alarm" "backup_missing" {
  alarm_name          = "calasign-saas-dev-backup-missing"
  alarm_description   = "No hubo un backup exitoso de Postgres de dev en las últimas 24 h. Ver README, sección Backups."
  namespace           = local.backup_metric_namespace
  metric_name         = "LastSuccess"
  dimensions          = { Environment = "dev" }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 24
  datapoints_to_alarm = 24
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

output "public_ip" {
  value = aws_eip.app.public_ip
}
output "instance_id" {
  value = aws_instance.app.id
}
output "bucket" {
  value = aws_s3_bucket.blobs.id
}
output "kms_key_arn" {
  value = aws_kms_key.seal.arn
}
output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
