-- The topic vocabulary (§22, §22.1, §22.2).
--
-- Nine sections and 50 leaves, which is the range §22.2 fixes and the reason it fixes it:
-- the classifier chooses from a closed set, so the whole leaf list travels in every prompt.
-- A hundred topics is a few thousand tokens and a model picks from it accurately; several
-- hundred is dearer per article and less precise, and a vocabulary too large for one prompt
-- needs retrieval before classification, which is a different design.
--
-- A migration rather than a screen. This is platform-controlled data, so it is written where
-- the schema is written: reviewed in git, applied identically to every deployment, diffable
-- afterwards. An editing UI would let staging and production drift, and what drifts is the
-- set of addresses /t/{slug} has promised to keep resolving (§8).
--
-- The descriptions are load-bearing in two directions at once, which is why there is one
-- field and not two. A reader sees them on /topics and at the head of a topic page, and the
-- classifier reads the same sentence to decide what belongs there. Two fields would drift,
-- and the drift would be invisible: the page would say one thing and the model would sort by
-- another.
--
-- The ids carry 2026-08-23 in their leading 48 bits (§12.2), which is true: that is when the
-- vocabulary was decided. Fixed literals because a seed that generated ids at apply time
-- would give staging and production different ids for the same topic, and article_topics
-- would then not be comparable between them.
--
-- Expect a revision. Some leaves will stay empty and one will collect a disproportionate
-- share and ask to be split. That is cheap: article_topics is derived data, recomputable
-- from revisions (§38.3), so the vocabulary can be wrong for a while without anything being
-- lost. Slugs are the exception — a slug is a public address, and §8 keeps it.
INSERT INTO topics (id, slug, label, description, parent_id, status, created_at) VALUES
  ('06G2YPD801KQAHWT0J1A5SK78R', 'ai', 'AI and machine learning', 'How models are built, run, judged and made safe.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD80207AF82XGSXKYQ3KM', 'llm', 'Large language models', 'Architecture, capabilities and limits of language models.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800G3CJPHJ2M074XEHC', 'agents', 'AI agents', 'Systems that plan, call tools and act with some autonomy.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8038ADD5F1386934W6W', 'training', 'Training and fine-tuning', 'Pre-training, fine-tuning, data curation and scaling.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800ZTAMQCNE7MEGH47M', 'inference', 'Inference and serving', 'Running models in production: latency, cost, quantisation, batching.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801S1P818EEZPCQ0KJ8', 'evaluation', 'Evaluation and benchmarks', 'Measuring what a model can do, and what a benchmark fails to measure.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802YZ30ZWDWHSDGYDF0', 'alignment', 'Alignment and safety', 'Making models behave as intended, and the ways they do not.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803QHGW54QKTTFSTDM8', 'multimodal', 'Vision, audio and multimodal', 'Models that work in images, audio, video or several modes at once.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801WY3KXKG49VDHY32G', 'retrieval', 'Retrieval and knowledge', 'Giving a model access to information it was not trained on.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801JZTCGSRXMWNKYBSR', 'prompting', 'Prompting and context', 'Constructing the input: instructions, context windows, structured output.', '06G2YPD801KQAHWT0J1A5SK78R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800PYT99Y3VZJSY8YN8', 'engineering', 'Software engineering', 'Designing, writing, testing and shipping software.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800R0HDK4H6NTTFMTFW', 'architecture', 'Software architecture', 'How systems are decomposed, and what each boundary costs.', '06G2YPD800PYT99Y3VZJSY8YN8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802EFXYY1XAA7ESTAR4', 'languages', 'Programming languages', 'Language design, type systems and what a language makes easy.', '06G2YPD800PYT99Y3VZJSY8YN8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802QDVTNBBGVMGQ6YX8', 'testing', 'Testing and verification', 'Establishing that software does what it claims, before somebody else finds out.', '06G2YPD800PYT99Y3VZJSY8YN8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803WZDQYCF2TZNX0EZG', 'performance', 'Performance engineering', 'Measuring, profiling and making things faster on purpose.', '06G2YPD800PYT99Y3VZJSY8YN8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803NGFC933SYQP4YG8C', 'tooling', 'Developer tooling', 'Build systems, editors, package managers and the work they remove.', '06G2YPD800PYT99Y3VZJSY8YN8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801NJEY6CF0B6ZDPS0G', 'web', 'The web platform', 'Browsers, standards, HTTP and what runs in front of a person.', '06G2YPD800PYT99Y3VZJSY8YN8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800BYG0QDAK5QW9AP28', 'open-source', 'Open source practice', 'Licensing, governance, maintenance and the economics of shared code.', '06G2YPD800PYT99Y3VZJSY8YN8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801AYH0Z8MG1WJVXXG8', 'infrastructure', 'Data and infrastructure', 'Where software runs and where its data lives.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800APWK65JGXFE71HS4', 'databases', 'Databases and storage', 'Query engines, storage layouts, consistency and durability.', '06G2YPD801AYH0Z8MG1WJVXXG8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD80138MQXVC4YHMXQS08', 'distributed-systems', 'Distributed systems', 'Coordination, replication, partial failure and what cannot be avoided.', '06G2YPD801AYH0Z8MG1WJVXXG8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803C90AQF33G97D97ZC', 'cloud', 'Cloud and serverless', 'Platforms, edge compute, deployment and what they charge for.', '06G2YPD801AYH0Z8MG1WJVXXG8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802T2XB1Z946N1AX0W4', 'observability', 'Observability', 'Logs, metrics, traces and knowing what a system is doing.', '06G2YPD801AYH0Z8MG1WJVXXG8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800VTZMV7DMXGF8QYJ0', 'networking', 'Networking', 'Protocols, routing, latency and the physical limits underneath.', '06G2YPD801AYH0Z8MG1WJVXXG8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801VM8SYDM5YV7T2QK0', 'data-engineering', 'Data engineering', 'Pipelines, warehouses and moving data without losing it.', '06G2YPD801AYH0Z8MG1WJVXXG8', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800ZEBZJ44WVRGEKE4R', 'security', 'Security and privacy', 'Attacks, defences, and what a system reveals about the people in it.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8016B7ZNKF63RRZ5WKW', 'cryptography', 'Cryptography', 'Primitives, protocols and the assumptions they rest on.', '06G2YPD800ZEBZJ44WVRGEKE4R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8030056TEY30ZBFWTSM', 'vulnerabilities', 'Vulnerabilities and exploits', 'How systems are broken, and the classes of bug that keep returning.', '06G2YPD800ZEBZJ44WVRGEKE4R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8028GKBJSF23BHV63FM', 'privacy', 'Privacy', 'What is collected, what is inferred, and what should be neither.', '06G2YPD800ZEBZJ44WVRGEKE4R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803BQ3XMGW0W2S75ERC', 'identity', 'Identity and authentication', 'Proving who is asking: passkeys, tokens, federation, revocation.', '06G2YPD800ZEBZJ44WVRGEKE4R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803EDS8MR9395XGCKMG', 'threat-modelling', 'Threat modelling', 'Deciding what you are defending against before deciding how.', '06G2YPD800ZEBZJ44WVRGEKE4R', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803KG7E28WH2GVSZH4M', 'science', 'Science and research', 'Findings, methods and the practice of research itself.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801C4VPP4XVPKQ8VD3G', 'mathematics', 'Mathematics', 'Proofs, structures and mathematical results.', '06G2YPD803KG7E28WH2GVSZH4M', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803TQFG6S746FRJCEG4', 'physics', 'Physics', 'Theory, experiment and physical models of the world.', '06G2YPD803KG7E28WH2GVSZH4M', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8002EYPDCVPJSVMWVSC', 'biology', 'Biology', 'Living systems, from molecules to ecosystems.', '06G2YPD803KG7E28WH2GVSZH4M', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803ZPPDCAQA34DX7CVC', 'climate', 'Climate and environment', 'Measurement, modelling and the state of the physical environment.', '06G2YPD803KG7E28WH2GVSZH4M', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8007YNWMXMBN1D0GPK4', 'methodology', 'Research methodology', 'Study design, statistics, replication and how findings go wrong.', '06G2YPD803KG7E28WH2GVSZH4M', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801XAFWCFG4FB9G7WAR', 'society', 'Society and policy', 'Institutions, rules and how technology lands in public life.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802CQ9906JSC7Q840DC', 'governance', 'Governance and institutions', 'How collective decisions are made, and by whom.', '06G2YPD801XAFWCFG4FB9G7WAR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802E0W41JWVPPDB4F0M', 'regulation', 'Law and regulation', 'Statutes, cases and the rules technology is subject to.', '06G2YPD801XAFWCFG4FB9G7WAR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD801F96APZZH3AA6BEKG', 'labour', 'Work and labour', 'Employment, automation and how work is organised.', '06G2YPD801XAFWCFG4FB9G7WAR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800RMH952NMPVR10SCC', 'education', 'Education', 'Teaching, learning and what institutions do with both.', '06G2YPD801XAFWCFG4FB9G7WAR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8014EYB8B69T8XMP9JR', 'information', 'Media and information', 'Publishing, provenance, misinformation and the flow of attention.', '06G2YPD801XAFWCFG4FB9G7WAR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8016JG4P93792Z2CRJW', 'business', 'Business and economics', 'Markets, firms and the money that moves through them.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8038T5MZ2XWFYE9244G', 'markets', 'Markets and economics', 'Prices, incentives and economic analysis.', '06G2YPD8016JG4P93792Z2CRJW', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD80172V4P6EX7K8RV440', 'startups', 'Startups', 'Founding, funding and the mechanics of a young company.', '06G2YPD8016JG4P93792Z2CRJW', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800PYSMPCAZ84ESNPKW', 'product', 'Product and design', 'Deciding what to build, and how it should behave.', '06G2YPD8016JG4P93792Z2CRJW', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD80030RVV7ZJHX1YPMY0', 'finance', 'Finance', 'Capital, risk, instruments and financial systems.', '06G2YPD8016JG4P93792Z2CRJW', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD8009N9X4WEQP6XWERMR', 'health', 'Health and medicine', 'Bodies, minds, treatments and the systems that deliver them.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800YMPNYADWJ4072B34', 'clinical', 'Clinical medicine', 'Diagnosis, treatment and evidence at the bedside.', '06G2YPD8009N9X4WEQP6XWERMR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803YKM8GFRWHPWE9824', 'public-health', 'Public health', 'Populations, epidemiology and health at scale.', '06G2YPD8009N9X4WEQP6XWERMR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802N0EDEE8PKZP3SMTC', 'biotech', 'Biotechnology', 'Engineering biological systems, and the tools that make it possible.', '06G2YPD8009N9X4WEQP6XWERMR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800JAEJ5WB6KNNT0K90', 'mental-health', 'Mental health', 'Psychiatry, psychology and mental wellbeing.', '06G2YPD8009N9X4WEQP6XWERMR', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800860HBAQVMA5J28N4', 'culture', 'Culture and humanities', 'What people have made, thought and said.', NULL, 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800JJTJTB37GQFEGVR8', 'history', 'History', 'The past, and the arguments about how to read it.', '06G2YPD800860HBAQVMA5J28N4', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802FS868FGA6TTWWN94', 'philosophy', 'Philosophy', 'Arguments about knowledge, ethics, mind and meaning.', '06G2YPD800860HBAQVMA5J28N4', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD802TDG8KFP428FV0JJG', 'language', 'Language and linguistics', 'How language works, changes and is studied.', '06G2YPD800860HBAQVMA5J28N4', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD800TM8AXKM82JGTJCJW', 'art', 'Art and design', 'Visual art, craft and design as practice and as object.', '06G2YPD800860HBAQVMA5J28N4', 'active', '2026-08-23T16:00:00.000Z'),
  ('06G2YPD803TCWERNH6PX1DWV7W', 'literature', 'Literature', 'Writing as a form, and reading as a discipline.', '06G2YPD800860HBAQVMA5J28N4', 'active', '2026-08-23T16:00:00.000Z');
