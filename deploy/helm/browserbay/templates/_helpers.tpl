{{/* The chart's short name. */}}
{{- define "browserbay.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The release's full name: used for the relay (or the all-in-one box) and its Service. */}}
{{- define "browserbay.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The node Deployment's name. */}}
{{- define "browserbay.nodeName" -}}
{{- printf "%s-node" (include "browserbay.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "browserbay.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels every object carries. Call with (dict "ctx" . "component" "relay"). */}}
{{- define "browserbay.labels" -}}
helm.sh/chart: {{ include "browserbay.chart" .ctx }}
{{ include "browserbay.selectorLabels" . }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
{{- end -}}

{{/* What selectors match on. Call with (dict "ctx" . "component" "relay"). */}}
{{- define "browserbay.selectorLabels" -}}
app.kubernetes.io/name: {{ include "browserbay.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* An image reference. Call with (dict "image" .Values.image "ctx" .). */}}
{{- define "browserbay.image" -}}
{{- printf "%s:%s" .image.repository (default .ctx.Chart.AppVersion .image.tag) -}}
{{- end -}}

{{- define "browserbay.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "browserbay.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The Secret holding the API key and the enrollment secrets. */}}
{{- define "browserbay.secretName" -}}
{{- default (include "browserbay.fullname" .) .Values.auth.existingSecret -}}
{{- end -}}

{{/* webBotAuth.mode as one of off, optional, always. YAML reads an unquoted `off` as false, so false means off. */}}
{{- define "browserbay.signingMode" -}}
{{- $mode := toString .Values.webBotAuth.mode -}}
{{- if eq $mode "false" -}}off{{- else -}}{{- $mode -}}{{- end -}}
{{- end -}}

{{/* Fails the render when mode is not one of the two, or webBotAuth is asked for without what it needs. */}}
{{- define "browserbay.validate" -}}
{{- if not (has .Values.mode (list "split" "allInOne")) -}}
{{- fail (printf "mode must be \"split\" or \"allInOne\", got %q" (toString .Values.mode)) -}}
{{- end -}}
{{- $signing := include "browserbay.signingMode" . -}}
{{- if not (has $signing (list "off" "optional" "always")) -}}
{{- fail (printf "webBotAuth.mode must be \"off\", \"optional\" or \"always\", got %q" $signing) -}}
{{- end -}}
{{- if ne $signing "off" -}}
{{- if not (regexMatch "^https://[^/]+$" (toString .Values.webBotAuth.agentUrl)) -}}
{{- fail "webBotAuth.agentUrl must be the https address the relay is served at, with no path, such as https://browsers.example.com" -}}
{{- end -}}
{{- if and (not .Values.webBotAuth.key) (not .Values.webBotAuth.existingSecret) -}}
{{- fail "webBotAuth needs a key: set webBotAuth.existingSecret (a Secret you manage), or webBotAuth.key. Make one with `docker run --rm ghcr.io/degoke/browserbay web-bot-auth`" -}}
{{- end -}}
{{- if and .Values.webBotAuth.key .Values.webBotAuth.existingSecret -}}
{{- fail "set webBotAuth.key or webBotAuth.existingSecret, not both" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The Web Bot Auth private key, from the Secret that holds it. Empty when nothing is signed. The relay publishes its public half, nodes sign with it. */}}
{{- define "browserbay.webBotAuthKeyEnv" -}}
{{- if ne (include "browserbay.signingMode" .) "off" }}
- name: BROWSERBAY_WEB_BOT_AUTH_KEY
  valueFrom:
    secretKeyRef:
      name: {{ default (printf "%s-web-bot-auth" (include "browserbay.fullname" .)) .Values.webBotAuth.existingSecret }}
      key: {{ .Values.webBotAuth.existingSecretKey }}
{{- end }}
{{- end -}}

{{/*
The relay address the nodes dial. node.relayUrl when set. Otherwise, only with node.allowInsecureRelay, the relay's own
Service: a node refuses plain http to another machine unless that opt-in says the network is trusted.
*/}}
{{- define "browserbay.nodeRelayUrl" -}}
{{- if .Values.node.relayUrl -}}
{{- .Values.node.relayUrl -}}
{{- else if .Values.node.allowInsecureRelay -}}
{{- printf "http://%s.%s.svc:%d" (include "browserbay.fullname" .) .Release.Namespace (int .Values.relay.service.port) -}}
{{- else -}}
{{- fail "node.relayUrl is required in split mode: the relay's https address (a node refuses plain http), or set node.allowInsecureRelay=true to use the in-cluster Service over plain http" -}}
{{- end -}}
{{- end -}}

{{/* The environment both the node and the all-in-one pod take from the node.* values. */}}
{{- define "browserbay.nodeEnv" -}}
- name: BROWSERBAY_MAX_CONTEXTS
  value: {{ int .Values.node.maxContexts | toString | quote }}
- name: BROWSERBAY_DRAIN_SECONDS
  value: {{ int .Values.node.drainSeconds | toString | quote }}
- name: BROWSERBAY_CHROMIUM_SANDBOX
  value: {{ .Values.node.sandbox | toString | quote }}
- name: BROWSERBAY_HEADLESS
  value: {{ .Values.node.headless | toString | quote }}
{{- with .Values.node.labels }}
- name: BROWSERBAY_NODE_LABELS
  value: {{ join "," . | quote }}
{{- end }}
{{- if .Values.node.exclusive }}
- name: BROWSERBAY_NODE_EXCLUSIVE
  value: "true"
{{- end }}
{{- if ne (include "browserbay.signingMode" .) "off" }}
- name: BROWSERBAY_WEB_BOT_AUTH
  value: {{ include "browserbay.signingMode" . | quote }}
- name: BROWSERBAY_WEB_BOT_AUTH_AGENT
  value: {{ .Values.webBotAuth.agentUrl | toString | quote }}
- name: BROWSERBAY_WEB_BOT_AUTH_FORMAT
  value: {{ .Values.webBotAuth.format | toString | quote }}
- name: BROWSERBAY_WEB_BOT_AUTH_TTL_SECONDS
  value: {{ int .Values.webBotAuth.ttlSeconds | toString | quote }}
{{- include "browserbay.webBotAuthKeyEnv" . | nindent 0 }}
{{- end }}
{{- end -}}
