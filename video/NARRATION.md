# Demo video narration script

The video (`ProofOfForest-demo.mp4`, 4:05, 1080p) uses a neural voice (Kokoro, open-weight TTS). To record it in your own voice instead, read each block starting at its timestamp. Each block has to fit before the next one starts; the ‘length’ column is how long the AI voice took.

**Easiest way to swap the voice:** play `ProofOfForest-demo-silent.mp4`, record yourself reading along in one take (phone voice memo is fine), save it as `my-voice.m4a`, then run:

```
ffmpeg -i ProofOfForest-demo-silent.mp4 -i my-voice.m4a -map 0:v -map 1:a -c:v copy -c:a aac -shortest ProofOfForest-demo-myvoice.mp4
```

Captions for upload (YouTube etc.) are in `ProofOfForest-demo.srt`.

| Starts at | Length | Narration |
|---|---|---|
| 0:00.7 | 5s | This is Proof Of Forest. Carbon credits that exist only if the forest does. |
| 0:05.9 | 24s | Voluntary carbon markets run on trust. Investigations have found forest credits sold for growth that never happened, and the same tonne counted more than once. Verification means expensive site audits that small projects can't afford, and buyers can't check the evidence themselves. So we built a system where the evidence is public, the check is automatic, and every tonne has a serial number. |
| 0:30.2 | 31s | It works in three layers. First, measure. Our engine pulls free Copernicus Sentinel-2 satellite imagery, masks out clouds, and compares the vegetation inside a project with a control ring around it. Second, attest. Three independent oracles re-check the report and sign it. Third, settle. An E-R-C 1155 smart contract mints credits only when two of the three oracles agree, and the numbers also pass the contract's own on-chain policy. |
| 1:01.9 | 5s | Here is the registry, with three case studies. All of them run on real satellite data. |
| 1:07.9 | 13s | First, Smritivan in Bhuj, Gujarat. A Miyawaki forest planted on a barren hillside. Drag the slider. In 2019 the slope is bare. By 2025, it's dense green. |
| 1:21.4 | 19s | In the N-D-V-I greenness index, the project went from 0.14 to 0.43. But the surrounding city also greened a little, so we only credit the difference: a net gain of 0.22. It holds across all thirty-six scene pairs, with one hundred percent cloud-free coverage. |
| 1:41.0 | 8s | That's almost fifteen hectares of new canopy. After an uncertainty deduction, five hundred and forty one tonnes of C O two. |
| 1:49.4 | 13s | Anyone can relay the signed attestation. I'll submit it, and the contract mints the credits. One batch, with unique serial numbers, and twenty percent held back in a buffer pool, in case the forest is ever lost. |
| 2:02.9 | 27s | Now, a fake. This hypothetical developer claims three hundred and sixty five hectares of reforestation in Hasdeo Arand, Chhattisgarh. The satellite shows the opposite. Dense forest in 2019, an open-cast coal mine by 2025. The greenness index fell from 0.56 to 0.09. When the signed verdict is submitted, the contract records the rejection on-chain. No credits, and a permanent public record. |
| 2:30.5 | 13s | The third case is the subtle one. A claim on the Banni grasslands in Kutch. Inside the polygon, the greenness index jumped by almost half. A simple before and after check would happily issue credits. |
| 2:44.0 | 16s | But zoom out to the landscape, and everything turned green. 2018 was a drought year, and 2020 had a strong monsoon. The control ring rose by the same amount, so the net gain is zero. Greenwashing caught, and rejected on-chain. |
| 3:00.8 | 6s | Back to the real credits. The developer sells two hundred and fifty tonnes to a buyer, Acme Steel. |
| 3:07.4 | 18s | Now acting as the buyer, they retire one hundred and twenty tonnes against their 2026 Scope 1 emissions. Retiring burns the tokens and assigns serial numbers one to one hundred and twenty to Acme, permanently. Here is the certificate, tied to the satellite report hash. |
| 3:25.8 | 12s | Anyone can verify a serial. Serial forty two: retired, in certificate number one. It can never be sold or claimed again. And the ledger shows every verification, including the rejections. |
| 3:38.9 | 25s | Proof Of Forest uses only free, public data, verifies a project in about ninety seconds, and is backed by forty five automated tests, including the real satellite reports, end to end. Sentinel-2 revisits every forest on Earth every five days, so projects can be monitored continuously, not once every few years. Every number in this demo is reproducible from the open source repo. Thank you. |
