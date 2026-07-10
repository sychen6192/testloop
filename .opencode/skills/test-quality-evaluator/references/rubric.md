# Test Quality Rubric — Full Scoring Criteria (Java) — v1.0

**This is the full scoring reference, containing detailed band descriptions and
Java code examples for every dimension. It is the authoritative source of truth
when the condensed rubric in SKILL.md is insufficient.**

## When to consult this file

Sub-agents should use the **condensed rubric in SKILL.md Part 3.1** for most
scoring decisions. Only consult this full file when:

- A test uses a pattern not covered in the condensed table
- Scoring a dimension requires distinguishing 3-4 from 5-6 (mid-band)
- The sub-agent's first instinct conflicts with the condensed criteria

Loading this full rubric into every parallel sub-agent wastes input tokens and
slows down evaluation significantly. Use it selectively, not by default.

## Scoring basics

Each dimension is scored 0-10 (integer). Weighted sum × 10 = total score (0-100).
Grades: A ≥ 85, B 70-84, C 55-69, D < 55.

**Important** — even with `temperature=0`, scores still drift ±1 per dimension
and ±3 total across runs. This is documented in SKILL.md Part 3.3 and
acceptable. Use grade buckets (A/B/C/D) for decisions, not precise scores.

---

## Dimension 1 — Effectiveness (Weight 25%)

**Question:** Will this test actually fail when the production code breaks?

**Primary signal:** PIT mutation score for the class under test.
**Fallback signal** (when PIT unavailable): AI analysis of whether assertions
verify real logic vs trivial checks.

| Score | Mutation Score | Description                                              |
|-------|----------------|----------------------------------------------------------|
| 9-10  | ≥ 80%          | Strong — mutants are reliably killed                     |
| 7-8   | 60-79%         | Acceptable                                               |
| 5-6   | 40-59%         | Room for improvement                                     |
| 3-4   | 20-39%         | Warning — many mutants survive                           |
| 0-2   | < 20% or trivial assertions | Severely insufficient                       |

**Assertion-quality signals (when mutation score unavailable):**
- ❌ Only `assertNotNull`, `assertTrue(true)`, `assertDoesNotThrow` without state check
- ❌ Assertion on mock return value only (tautology)
- ✅ Exact-value assertions (`isEqualTo`, `isEqualByComparingTo`)
- ✅ State-based assertions on the SUT after the action

**Java examples:**

❌ 0-2 band — trivial assertion
```java
@Test
void testCalculateDiscount() {
    BigDecimal result = discountService.calculate(new BigDecimal("100"), 0.2);
    assertNotNull(result);
}
```

✅ 9-10 band — real verification
```java
@Test
void calculate_withTwentyPercentDiscount_returnsDiscountedPrice() {
    BigDecimal result = discountService.calculate(new BigDecimal("100"), 0.2);
    assertThat(result).isEqualByComparingTo(new BigDecimal("80"));
}
```

---

## Dimension 2 — Coverage (Weight 20%)

**Question:** How much of the production code's behavior space is actually tested?

**Primary signal:** JaCoCo branch coverage for the class under test.
**Fallback signal:** AI analysis of whether happy / edge / error paths are covered.

| Score | Branch Coverage | Description                                  |
|-------|-----------------|----------------------------------------------|
| 9-10  | ≥ 90%           | Excellent                                    |
| 7-8   | 75-89%          | Good (near SonarQube default 80%)            |
| 5-6   | 60-74%          | Happy path only                              |
| 3-4   | 40-59%          | Key branches uncovered                       |
| 0-2   | < 40%           | Most logic untested                          |

Use **branch** coverage, not line coverage. A single `if (x && y)` can hit 100%
line coverage while testing only one branch combination.

**Required scenario types (for missing-case analysis):**
- Happy path — normal inputs
- Edge cases — null, zero, negative, max value, boundary values
- Error cases — invalid input, exception handling

**Java example — only happy path (5-6 band):**
```java
class PriceCalculatorTest {
    @Test
    void calculateTotal_normalInput_returnsCorrectAmount() {
        Order order = new Order(List.of(new Item("A", 100), new Item("B", 200)));
        assertThat(calculator.calculateTotal(order)).isEqualTo(300);
    }
    // missing: empty order, null input, max value, negative price...
}
```

**Java example — comprehensive (9-10 band):**
```java
class PriceCalculatorTest {
    @Test void calculateTotal_withMultipleItems_returnsSum() { /* ... */ }
    @Test void calculateTotal_withEmptyOrder_returnsZero() { /* ... */ }
    @Test void calculateTotal_withNullOrder_throwsIllegalArgumentException() {
        assertThatThrownBy(() -> calculator.calculateTotal(null))
            .isInstanceOf(IllegalArgumentException.class);
    }
    @Test void calculateTotal_withNegativePrice_throwsInvalidPriceException() { /* ... */ }

    @ParameterizedTest
    @ValueSource(ints = {0, 1, Integer.MAX_VALUE})
    void calculateTotal_boundaryValues_handlesCorrectly(int price) { /* ... */ }
}
```

---

## Dimension 3 — Independence (Weight 15%)

**Question:** Can every test run independently, in any order, in any subset?

Maps to **I (Independent)** in the FIRST principles.

| Score | Description                                                         |
|-------|---------------------------------------------------------------------|
| 9-10  | Fully independent                                                   |
| 7-8   | Good; limited read-only shared fixtures                             |
| 5-6   | Some order-dependence or shared state without cleanup               |
| 3-4   | Clear order dependency; global state mutated without reset          |
| 0-2   | Breaks when order changes                                           |

**Common violations (detectable by static analysis):**
- `static` mutable fields in the test class
- `@TestInstance(Lifecycle.PER_CLASS)` + mutable state + no `@BeforeEach` reset
- `@TestMethodOrder` combined with state carried across methods
- Dependency on leftover DB / filesystem state
- Shared `@TempDir` without cleanup (less serious)

**Java example — 0-2 band:**
```java
class UserServiceTest {
    private static List<User> users = new ArrayList<>();

    @Test @Order(1)
    void createUser() {
        users.add(userService.create("Alice"));
        assertThat(users).hasSize(1);
    }

    @Test @Order(2)
    void findUser() {
        // Depends on createUser running first
        User found = userService.findById(users.get(0).getId());
        assertThat(found).isNotNull();
    }
}
```

**Java example — 9-10 band:**
```java
class UserServiceTest {
    private UserService userService;

    @BeforeEach
    void setUp() {
        userService = new UserService(new InMemoryUserRepository());
    }

    @Test
    void create_withValidName_returnsUserWithId() { /* ... */ }

    @Test
    void findById_existingUser_returnsUser() {
        User created = userService.create("Alice");
        User found = userService.findById(created.getId());
        assertThat(found).isEqualTo(created);
    }
}
```

---

## Dimension 4 — Readability & Structure (Weight 15%)

**Question:** Can another engineer understand this test in 30 seconds?

| Score | Description                                                    |
|-------|----------------------------------------------------------------|
| 9-10  | Clear names, AAA structure, no magic numbers, no test smells   |
| 7-8   | Readable; minor magic numbers                                  |
| 5-6   | Generic names; requires reading body to understand intent      |
| 3-4   | Meaningless names, chaotic structure                           |
| 0-2   | Unintelligible                                                 |

**Checklist for AI evaluation:**
- **Naming:** `methodName_scenario_expectedResult` (e.g. `withdraw_withInsufficientBalance_throwsException`)
- **Structure:** Clear Arrange / Act / Assert sections (comments OK but blank lines also fine)
- **Magic numbers:** Raw numeric literals with unclear meaning → deduction
- **One behavior per test:** Multiple unrelated assertions in a single `@Test` → deduction
- **Test smells** (see Meszaros): Eager Test, Mystery Guest, Assertion Roulette

**Java example — 0-2 band:**
```java
@Test
void test1() {
    var x = new OrderService(new PaymentGateway());
    var r = x.process(new Order(1L, 100, 3));
    assertTrue(r.getCode() == 200 && r.getAmount() > 0);
}
```

**Java example — 9-10 band:**
```java
private static final long VALID_CUSTOMER_ID = 1L;
private static final int UNIT_PRICE = 100;
private static final int QUANTITY = 3;
private static final int EXPECTED_HTTP_OK = 200;

@Test
void process_withValidOrder_returnsSuccessResponse() {
    // Arrange
    OrderService orderService = new OrderService(new PaymentGateway());
    Order order = new Order(VALID_CUSTOMER_ID, UNIT_PRICE, QUANTITY);

    // Act
    OrderResult result = orderService.process(order);

    // Assert
    assertThat(result.getCode()).isEqualTo(EXPECTED_HTTP_OK);
    assertThat(result.getAmount()).isPositive();
}
```

---

## Dimension 5 — Fast & Reliable (Weight 15%)

**Question:** Does the test run fast and consistently?

Maps to **F (Fast)** and **R (Repeatable)** in FIRST.

**Primary signal:** CI execution logs from the last 30 days (flaky rate + p95 duration).
**Fallback signal:** Static pattern detection in the test code.

| Score | Flaky Rate | Exec Time       |
|-------|------------|-----------------|
| 9-10  | 0%         | < 100 ms        |
| 7-8   | < 1%       | Reasonable      |
| 5-6   | 1-5%       | Noticeably slow |
| 3-4   | 5-10%      | Impacts CI time |
| 0-2   | > 10%      | Needs retry/sleep to pass |

**Flaky smell patterns to flag statically:**
- `Thread.sleep(...)` — brittle timing
- `LocalDateTime.now()` / `new Date()` / `System.currentTimeMillis()` without injection
- `Random` without a fixed seed
- Real network / DB calls (non-TestContainer)
- Async results asserted without `Awaitility` or proper synchronization

**Java example — 0-2 band:**
```java
@Test
void createdAt_reflectsCurrentTime() {
    Order order = orderService.create("item-1");
    assertThat(order.getCreatedAt()).isEqualTo(LocalDateTime.now());
    // Fails across second boundary; fails on slow CI
}

@Test
void asyncProcessor_processesEventually() throws InterruptedException {
    processor.submit("task");
    Thread.sleep(500);
    assertThat(processor.isDone()).isTrue();
}
```

**Java example — 9-10 band:**
```java
@Test
void createdAt_usesInjectedClock() {
    Clock fixedClock = Clock.fixed(Instant.parse("2026-04-22T10:00:00Z"), ZoneOffset.UTC);
    OrderService orderService = new OrderService(fixedClock);

    Order order = orderService.create("item-1");

    assertThat(order.getCreatedAt())
        .isEqualTo(LocalDateTime.of(2026, 4, 22, 10, 0, 0));
}

@Test
void asyncProcessor_processesEventually() {
    processor.submit("task");
    await().atMost(2, SECONDS)
        .untilAsserted(() -> assertThat(processor.isDone()).isTrue());
}
```

---

## Dimension 6 — Mock Appropriateness (Weight 10%)

**Question:** Are mocks used at the right boundary, or is the test over-mocked?

Based on Fowler's *Mocks Aren't Stubs* and Meszaros' Excessive Setup smell.

| Score | Description                                                             |
|-------|-------------------------------------------------------------------------|
| 9-10  | Mocks only at external boundaries; internal logic uses real objects     |
| 7-8   | Reasonable                                                              |
| 5-6   | Too many mocks; some signs of testing the mock                          |
| 3-4   | Over-mocked; test only verifies mock interactions                       |
| 0-2   | No real logic verification                                              |

**Rules of thumb:**
| Category | Guidance |
|----------|----------|
| External I/O (DB, API, filesystem, time, random) | ✅ mock |
| Value objects, pure functions, DTOs | ❌ don't mock |
| Internal collaborators | ⚠️ avoid; case-by-case |

**Warning patterns to detect:**
- 5+ `@Mock` fields in one test class
- Every assertion is `verify(mock)...` with no state-based assertion
- Mocks of `@Value`, record types, or classes without external dependencies
- Heavy `when(...).thenReturn(...)` setup that effectively re-implements the SUT

**Java example — 0-2 band:**
```java
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {
    @Mock private OrderValidator validator;
    @Mock private PriceCalculator calculator;
    @Mock private DiscountRule discountRule;
    @Mock private Order order;                    // value object — wrong
    @Mock private OrderRepository repository;
    @Mock private PaymentGateway paymentGateway;

    @Test
    void process_validOrder_callsAllCollaborators() {
        when(validator.isValid(order)).thenReturn(true);
        when(calculator.calculate(order)).thenReturn(100);
        when(discountRule.apply(100)).thenReturn(80);

        orderService.process(order);

        verify(validator).isValid(order);
        verify(calculator).calculate(order);
        verify(discountRule).apply(100);
        // no state assertion on the result
    }
}
```

**Java example — 9-10 band:**
```java
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {
    @Mock private OrderRepository repository;
    @Mock private PaymentGateway paymentGateway;

    private final OrderValidator validator = new OrderValidator();
    private final PriceCalculator calculator = new PriceCalculator();
    private final DiscountRule discountRule = new DiscountRule();

    private OrderService orderService;

    @BeforeEach
    void setUp() {
        orderService = new OrderService(
            validator, calculator, discountRule, repository, paymentGateway);
    }

    @Test
    void process_orderWithDiscount_chargesDiscountedAmount() {
        Order order = new Order(1L, 100, 3);
        when(paymentGateway.charge(any(), eq(240)))
            .thenReturn(PaymentResult.success("TXN-001"));

        OrderResult result = orderService.process(order);

        assertThat(result.getAmount()).isEqualTo(240);
        assertThat(result.getTransactionId()).isEqualTo("TXN-001");
    }
}
```

---

## Total score formula

```
weighted = 0.25*d1 + 0.20*d2 + 0.15*d3 + 0.15*d4 + 0.15*d5 + 0.10*d6
total    = weighted * 10     // 0-100 scale
```

**Grade mapping:**
- 85-100 → A (reference quality, can be used as team example)
- 70-84  → B (good, minor improvements)
- 55-69  → C (usable, prioritize improvement)
- < 55   → D (insufficient, consider rewriting)

**This is computed by the orchestrator, not the LLM** (per SKILL.md P3).
