# Cash application eval report

Extractor: **offline**  
Run: 2026-10-21 02:01 UTC

| Metric | Development set (used while building) | Held-out set | Stress set (hand-written) |
| --- | --- | --- | --- |
| Payments | 160 | 90 | 20 |
| Wrong auto-applications | 0 | 0 | 0 |
| Auto-apply precision | 100.0% | 100.0% | 100.0% |
| Straight-through rate | 80.6% | 78.9% | 50.0% |
| Correct escalations | 31/31 | 19/19 | 5/5 |
| Missed automation (sent to review, could have applied) | 0 | 0 | 5 |

The development and held-out sets come from the same generator with different seeds. The stress set is 20 hand-written
cases the generator never produces, so it is the most honest of the three.

## Stress set, case by case

| Case | Expected | Agent | Result |
| --- | --- | --- | --- |
| check number next to invoice | apply | review (reference not open) | missed, sent to review |
| invoice with dash prefix | apply | auto apply (exact reference) | correct |
| misspelled payer, good reference | apply | auto apply (exact reference) | correct |
| payer pays another customer's invoice | review | review (payer mismatch) | correct |
| installment payment | review | review (short pay) | correct |
| dollar amount written in remittance | apply | auto apply (exact reference) | correct |
| leading zeros on invoice number | apply | review (reference not open) | missed, sent to review |
| discount on only one of two invoices | apply | review (short pay) | missed, sent to review |
| per-invoice amounts listed | apply | auto apply (exact reference) | correct |
| customer quoted the wrong invoice | review | review (short pay) | correct |
| three invoices, no reference | apply | review (invoice combination) | missed, sent to review |
| card fee deducted | review | review (short pay) | correct |
| duplicate payment for a paid invoice | review | review (reference not open) | correct |
| construction pay application language | apply | auto apply (unique amount) | correct |
| one PO split across two invoices | apply | auto apply (exact reference) | correct |
| joint check from a bank | apply | auto apply (exact reference) | correct |
| year in remittance | apply | auto apply (exact reference) | correct |
| ZIP code in remittance | apply | review (reference not open) | missed, sent to review |
| discount rounded on the total | apply | auto apply (early pay discount) | correct |
| phone number in remittance | apply | auto apply (exact reference) | correct |

## By scenario (generated sets)

| Scenario | Development | Held-out |
| --- | --- | --- |
| ambiguous same amount | 7/7 | 3/3 |
| discount after deadline | 6/6 | 6/6 |
| early pay discount | 23/23 | 11/11 |
| multi invoice | 17/17 | 11/11 |
| no reference two invoices | 6/6 | 4/4 |
| no reference unique amount | 13/13 | 4/4 |
| overpayment | 3/3 | 4/4 |
| payer name variant | 19/19 | 13/13 |
| po reference | 13/13 | 2/2 |
| short pay | 9/9 | 4/4 |
| single invoice | 28/28 | 17/17 |
| typo in invoice number | 10/10 | 9/9 |
| unknown payer | 6/6 | 2/2 |
