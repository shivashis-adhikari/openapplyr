import { fold } from '../util/text'

/**
 * Named skills, tools and credentials, used to (1) find the technologies a posting asks for and
 * (2) let fact-lock check that a tailored resume names nothing the profile does not.
 * Canonical spelling first; aliases map to it.
 */
const CANON = `
JavaScript|TypeScript|Python|Java|Kotlin|Scala|Go|Rust|C|C++|C#|F#|Ruby|PHP|Perl|Swift|Objective-C|Dart|Elixir|Erlang|Haskell|Clojure|OCaml|R|Julia|MATLAB|Lua|Groovy|Bash|PowerShell|SQL|PL/SQL|T-SQL|COBOL|Fortran|Assembly|Solidity|Zig|Nim|Crystal|VB.NET|Visual Basic|Apex|ABAP|SAS|Stata|SPSS|VHDL|Verilog|SystemVerilog|WebAssembly|GraphQL|HTML|CSS|Sass|Less|Tailwind CSS|Bootstrap|
React|React Native|Next.js|Vue.js|Nuxt|Angular|AngularJS|Svelte|SvelteKit|SolidJS|Ember.js|Backbone.js|jQuery|Redux|MobX|Zustand|RxJS|Three.js|D3.js|WebGL|Electron|Tauri|Flutter|Ionic|Xamarin|SwiftUI|UIKit|Jetpack Compose|Android|iOS|Expo|Storybook|Webpack|Vite|Rollup|esbuild|Babel|Jest|Vitest|Mocha|Cypress|Playwright|Selenium|Puppeteer|Testing Library|JUnit|pytest|RSpec|TestNG|Postman|
Node.js|Deno|Bun|Express|NestJS|Fastify|Koa|Hapi|Django|Flask|FastAPI|Pyramid|Tornado|Celery|SQLAlchemy|Pandas|NumPy|SciPy|Polars|Spring|Spring Boot|Hibernate|Quarkus|Micronaut|Ruby on Rails|Sinatra|Laravel|Symfony|CodeIgniter|ASP.NET|.NET|.NET Core|Entity Framework|Phoenix|Gin|Echo|Fiber|Actix|Axum|Tokio|gRPC|REST|SOAP|WebSockets|OpenAPI|tRPC|Protobuf|Thrift|Kafka Streams|
PostgreSQL|MySQL|MariaDB|SQLite|Oracle Database|Microsoft SQL Server|MongoDB|Redis|Memcached|Cassandra|ScyllaDB|DynamoDB|Couchbase|CouchDB|Neo4j|Elasticsearch|OpenSearch|Solr|ClickHouse|Snowflake|BigQuery|Redshift|Databricks|Teradata|Vertica|Druid|Pinot|TimescaleDB|InfluxDB|Prometheus|CockroachDB|TiDB|Vitess|Supabase|Firebase|Firestore|PlanetScale|Neon|DuckDB|Apache Iceberg|Delta Lake|Apache Hudi|Pinecone|Weaviate|Milvus|Qdrant|pgvector|Chroma|
AWS|Amazon EC2|Amazon S3|AWS Lambda|Amazon ECS|Amazon EKS|Amazon RDS|Amazon Aurora|Amazon SQS|Amazon SNS|Amazon Kinesis|AWS Glue|Amazon Athena|Amazon EMR|Amazon SageMaker|AWS CloudFormation|AWS CDK|Amazon CloudWatch|AWS IAM|Amazon VPC|Amazon Route 53|Amazon CloudFront|Amazon API Gateway|AWS Step Functions|Amazon Bedrock|
Google Cloud|Google Kubernetes Engine|Cloud Run|Cloud Functions|Pub/Sub|Dataflow|Dataproc|Vertex AI|Cloud Storage|Cloud SQL|Spanner|Microsoft Azure|Azure DevOps|Azure Functions|Azure Kubernetes Service|Azure SQL|Cosmos DB|Azure Data Factory|Azure Synapse|Azure OpenAI|Heroku|Vercel|Netlify|Cloudflare|Cloudflare Workers|DigitalOcean|Linode|Fly.io|Render|Railway|OpenShift|IBM Cloud|Oracle Cloud|Alibaba Cloud|
Docker|Kubernetes|Helm|Kustomize|Terraform|Pulumi|Ansible|Chef|Puppet|SaltStack|Packer|Vagrant|Nomad|Consul|Vault|Istio|Linkerd|Envoy|NGINX|Apache HTTP Server|HAProxy|Traefik|Jenkins|GitHub Actions|GitLab CI|CircleCI|Travis CI|Buildkite|TeamCity|Bamboo|Argo CD|Argo Workflows|Flux|Spinnaker|Tekton|Bazel|Gradle|Maven|Make|CMake|npm|Yarn|pnpm|Git|GitHub|GitLab|Bitbucket|Perforce|SVN|Linux|Unix|Windows Server|macOS|Ubuntu|Debian|Red Hat Enterprise Linux|CentOS|systemd|
Grafana|Datadog|New Relic|Splunk|Sumo Logic|Honeycomb|Sentry|PagerDuty|Opsgenie|OpenTelemetry|Jaeger|Zipkin|ELK Stack|Loki|Fluentd|Logstash|Kibana|Nagios|Zabbix|Dynatrace|AppDynamics|
Apache Kafka|RabbitMQ|ActiveMQ|NATS|Apache Pulsar|ZeroMQ|Amazon MQ|Apache Spark|PySpark|Apache Flink|Apache Beam|Apache Airflow|Dagster|Prefect|Luigi|dbt|Fivetran|Airbyte|Stitch|Talend|Informatica|Apache Hadoop|Hive|Presto|Trino|Apache NiFi|Apache Storm|Looker|Tableau|Power BI|Metabase|Superset|Mode|Qlik|Sisense|Hex|Amplitude|Mixpanel|Segment|Heap|Google Analytics|Snowplow|Excel|Google Sheets|VBA|
TensorFlow|PyTorch|Keras|JAX|scikit-learn|XGBoost|LightGBM|CatBoost|Hugging Face|Transformers|LangChain|LlamaIndex|OpenAI API|Anthropic API|MLflow|Kubeflow|Ray|Weights & Biases|ONNX|TensorRT|CUDA|OpenCV|spaCy|NLTK|Gensim|Stable Diffusion|RAG|LLM|NLP|Computer Vision|Reinforcement Learning|Deep Learning|Machine Learning|Time Series|A/B Testing|Statistics|Bayesian Statistics|Causal Inference|Recommender Systems|
Figma|Sketch|Adobe XD|Adobe Photoshop|Adobe Illustrator|Adobe InDesign|Adobe After Effects|Adobe Premiere Pro|Adobe Creative Cloud|Canva|Framer|Webflow|InVision|Zeplin|Principle|ProtoPie|Miro|FigJam|Blender|Cinema 4D|Maya|Unity|Unreal Engine|Godot|AutoCAD|SolidWorks|Revit|Rhino|SketchUp|Fusion 360|CATIA|ANSYS|
Salesforce|HubSpot|Marketo|Pardot|Mailchimp|Braze|Iterable|Klaviyo|Customer.io|Intercom|Zendesk|Freshdesk|ServiceNow|Jira|Confluence|Asana|Trello|Linear|Notion|Monday.com|ClickUp|Airtable|Zapier|Make.com|Workato|MuleSoft|SAP|SAP S/4HANA|Oracle NetSuite|NetSuite|Workday|QuickBooks|Xero|Sage|Stripe|Adyen|Braintree|PayPal|Plaid|Shopify|Magento|WooCommerce|BigCommerce|WordPress|Drupal|Contentful|Sanity|Strapi|Google Ads|Meta Ads|LinkedIn Ads|SEMrush|Ahrefs|Moz|Google Search Console|Google Tag Manager|Outreach|Salesloft|Gong|Apollo.io|ZoomInfo|LinkedIn Sales Navigator|Gainsight|ChurnZero|Greenhouse|Lever|Workday HCM|BambooHR|ADP|Gusto|Rippling|
OAuth|OpenID Connect|SAML|JWT|TLS|PKI|SIEM|SOAR|EDR|Burp Suite|Metasploit|Wireshark|Nmap|Snort|Suricata|CrowdStrike|SentinelOne|Palo Alto Networks|Fortinet|Okta|Auth0|Active Directory|Azure AD|Keycloak|Zero Trust|OWASP|SOC 2|ISO 27001|PCI DSS|HIPAA|GDPR|FedRAMP|NIST|CIS Benchmarks|
Agile|Scrum|Kanban|SAFe|Lean|Six Sigma|DevOps|SRE|MLOps|DataOps|CI/CD|TDD|BDD|DDD|Microservices|Event-Driven Architecture|Serverless|Distributed Systems|System Design|Data Modeling|ETL|ELT|Data Warehousing|Data Governance|Master Data Management|
AWS Certified Solutions Architect|AWS Certified Developer|AWS Certified SysOps Administrator|AWS Certified DevOps Engineer|Google Professional Cloud Architect|Azure Solutions Architect Expert|Certified Kubernetes Administrator|Certified Kubernetes Application Developer|CISSP|CISM|CISA|CEH|OSCP|Security+|Network+|CCNA|CCNP|PMP|PRINCE2|CSM|PSM|CPA|CFA|FRM|ACCA|CIMA|SHRM-CP|SHRM-SCP|PHR|Six Sigma Green Belt|Six Sigma Black Belt|ITIL|TOGAF|CKA|CKAD
`

const ALIASES: Record<string, string> = {
  js: 'JavaScript', ecmascript: 'JavaScript', ts: 'TypeScript', golang: 'Go', 'c plus plus': 'C++', cpp: 'C++', 'c sharp': 'C#', csharp: 'C#', py: 'Python', python3: 'Python',
  node: 'Node.js', nodejs: 'Node.js', 'node js': 'Node.js', reactjs: 'React', 'react.js': 'React', 'react js': 'React', vue: 'Vue.js', vuejs: 'Vue.js', nextjs: 'Next.js', 'next js': 'Next.js', angularjs: 'AngularJS', 'angular.js': 'AngularJS',
  postgres: 'PostgreSQL', postgresql: 'PostgreSQL', psql: 'PostgreSQL', mssql: 'Microsoft SQL Server', 'sql server': 'Microsoft SQL Server', mongo: 'MongoDB', 'elastic search': 'Elasticsearch', es: 'Elasticsearch',
  k8s: 'Kubernetes', kube: 'Kubernetes', eks: 'Amazon EKS', gke: 'Google Kubernetes Engine', aks: 'Azure Kubernetes Service', ecs: 'Amazon ECS', ec2: 'Amazon EC2', s3: 'Amazon S3', lambda: 'AWS Lambda', rds: 'Amazon RDS', sqs: 'Amazon SQS', sns: 'Amazon SNS', kinesis: 'Amazon Kinesis', sagemaker: 'Amazon SageMaker', cloudformation: 'AWS CloudFormation', cdk: 'AWS CDK', cloudwatch: 'Amazon CloudWatch',
  gcp: 'Google Cloud', 'google cloud platform': 'Google Cloud', azure: 'Microsoft Azure', 'amazon web services': 'AWS', 'github action': 'GitHub Actions', 'gitlab ci/cd': 'GitLab CI', argocd: 'Argo CD', 'argo cd': 'Argo CD',
  kafka: 'Apache Kafka', spark: 'Apache Spark', flink: 'Apache Flink', airflow: 'Apache Airflow', hadoop: 'Apache Hadoop', beam: 'Apache Beam', pulsar: 'Apache Pulsar', nifi: 'Apache NiFi',
  tf: 'TensorFlow', tensorflow2: 'TensorFlow', torch: 'PyTorch', sklearn: 'scikit-learn', 'scikit learn': 'scikit-learn', hf: 'Hugging Face', huggingface: 'Hugging Face', 'w&b': 'Weights & Biases', wandb: 'Weights & Biases', llms: 'LLM', 'large language models': 'LLM', 'large language model': 'LLM', ml: 'Machine Learning', dl: 'Deep Learning', cv: 'Computer Vision', rl: 'Reinforcement Learning',
  'power bi': 'Power BI', powerbi: 'Power BI', ga4: 'Google Analytics', gtm: 'Google Tag Manager', sfdc: 'Salesforce', 'ms excel': 'Excel', 'microsoft excel': 'Excel', photoshop: 'Adobe Photoshop', illustrator: 'Adobe Illustrator', indesign: 'Adobe InDesign', 'after effects': 'Adobe After Effects', premiere: 'Adobe Premiere Pro', xd: 'Adobe XD',
  ci: 'CI/CD', 'ci/cd': 'CI/CD', cicd: 'CI/CD', 'continuous integration': 'CI/CD', rest: 'REST', 'restful': 'REST', 'rest api': 'REST', 'restful apis': 'REST', grpc: 'gRPC', graphql: 'GraphQL', ws: 'WebSockets', websocket: 'WebSockets',
  'ruby on rails': 'Ruby on Rails', rails: 'Ruby on Rails', 'spring framework': 'Spring', springboot: 'Spring Boot', 'dot net': '.NET', dotnet: '.NET', 'asp.net core': 'ASP.NET', netsuite: 'NetSuite', 's/4hana': 'SAP S/4HANA',
  'security+ certification': 'Security+', 'comptia security+': 'Security+', 'aws solutions architect': 'AWS Certified Solutions Architect', 'certified scrum master': 'CSM', 'project management professional': 'PMP', 'soc2': 'SOC 2', 'iso27001': 'ISO 27001', 'pci': 'PCI DSS', 'terraform cloud': 'Terraform', 'pg': 'PostgreSQL', 'tailwind': 'Tailwind CSS', 'tailwindcss': 'Tailwind CSS', 'sass/scss': 'Sass', scss: 'Sass',
  'd3': 'D3.js', 'threejs': 'Three.js', 'vitejs': 'Vite', 'webpack5': 'Webpack', 'jest.js': 'Jest', 'openai': 'OpenAI API', 'chatgpt api': 'OpenAI API', 'claude api': 'Anthropic API', 'dbt core': 'dbt', 'elk': 'ELK Stack',
}

export const TERMS: string[] = CANON.split(/\|\n?|\n/).map((t) => t.trim()).filter(Boolean)
const BY_FOLD = new Map<string, string>()
for (const t of TERMS) BY_FOLD.set(fold(t), t)
for (const [alias, canon] of Object.entries(ALIASES)) BY_FOLD.set(fold(alias), canon)

/** Canonical name for a skill or tool, or null when it is not in the dictionary. */
export function canonicalTerm(s: string): string | null {
  return BY_FOLD.get(fold(s)) ?? null
}

/** Terms that are too short or too common as English words to find by scanning prose. */
const PROSE_UNSAFE = new Set(['C', 'R', 'Go', 'REST', 'Make', 'Mode', 'Hex', 'Ray', 'Flux', 'Echo', 'Fiber', 'Render', 'Railway', 'Lean', 'Sage', 'Outreach', 'Linear', 'Notion', 'Bun', 'Chef', 'Puppet', 'Vault', 'Consul', 'Lever', 'Greenhouse', 'Workday', 'Excel', 'Spring', 'Maya', 'Rhino', 'Unity', 'Chroma', 'Presto', 'Mode', 'Heap', 'Segment', 'Looker', 'Stata', 'Loki', 'Envoy', 'Nomad', 'Neon', 'Canva', 'Framer', 'Sketch', 'Miro', 'Asana', 'Druid', 'Pinot', 'Solr', 'Hive', 'Storm', 'Luigi', 'Prefect', 'Dagster', 'Ember.js', 'Assembly', 'Statistics', 'Security+', 'Agile', 'Scrum', 'Kanban'])

/**
 * Finds dictionary terms mentioned in text. Short or ambiguous terms (Go, R, Excel...) are only
 * matched when they appear capitalized as a standalone token, never inside other words.
 */
export function findTerms(text: string): string[] {
  const found = new Set<string>()
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9+#./&-]*[A-Za-z0-9+#]|[A-Za-z0-9]/g) ?? []
  // Try 4-, 3-, 2- and 1-word windows so multi-word terms win over their parts.
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 4; n >= 1; n--) {
      if (i + n > tokens.length) continue
      const phrase = tokens.slice(i, i + n).join(' ')
      const canon = BY_FOLD.get(fold(phrase))
      if (!canon) continue
      if (PROSE_UNSAFE.has(canon) && (n > 1 ? false : phrase !== canon)) continue
      found.add(canon)
      i += n - 1
      break
    }
  }
  return [...found]
}
