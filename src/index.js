const SOLIDARITY_TECH_API = "https://api.solidarity.tech/v1";

export default {
  async fetch(request, env, ctx) {
    // Only accept POST requests
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Verify the webhook secret in the URL path
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/|\/$/g, "");
    const secret = (env.WEBHOOK_SECRET || "").trim();
    if (!secret || path !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!Array.isArray(payload)) {
      return new Response("Expected array payload", { status: 400 });
    }

    // Respond immediately to Action Network (must be within 500ms)
    // Process the ST sync in the background via waitUntil
    ctx.waitUntil(processPayload(payload, env));

    return new Response("OK", { status: 200 });
  },
};

async function processPayload(payload, env) {
  for (const item of payload) {
    console.log("Item keys:", Object.keys(item));
    const action = item["osdi:signature"] || item["osdi:outreach"] || item["osdi:submission"];
    if (!action || !action.person) {
      console.log("Skipping item - no recognized action type or no person");
      continue;
    }

    const person = action.person;
    const anTags = action.add_tags || [];
    console.log("Person custom_fields:", JSON.stringify(person.custom_fields));

    const stUser = buildSolidarityTechUser(person, anTags, env);

    stUser.add_tags = ["Action Network"];

    // Track petition and involvement via custom user property checkboxes
    const petitionValues = ["Signed petition"];
    const involvedField = (person.custom_fields || {})["Would you like to get involved with our campaign to kick ICE out of our campus and community? _Yes"];
    if (involvedField) {
      petitionValues.push("Checked get involved box");
    }
    if (!stUser.custom_user_properties) stUser.custom_user_properties = {};
    stUser.custom_user_properties["anti-ice-petition"] = petitionValues;

    // Look up existing user to preserve their chapter memberships as secondary
    const primaryChapterId = parseInt(env.SOLIDARITY_TECH_CHAPTER_ID, 10);
    if (stUser.email) {
      try {
        const lookupResponse = await fetch(`${SOLIDARITY_TECH_API}/users?email=${encodeURIComponent(stUser.email)}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${env.SOLIDARITY_TECH_API_KEY}`,
          },
        });
        if (lookupResponse.ok) {
          const lookupData = await lookupResponse.json();
          if (lookupData.users && lookupData.users.length > 0) {
            let existingChapterIds = lookupData.users[0].chapter_ids || [];
            // Remove the primary chapter ID from the list to avoid duplicates
            existingChapterIds = existingChapterIds.filter(id => id !== primaryChapterId);
            if (existingChapterIds.length > 0) {
              stUser.add_chapter_ids = existingChapterIds;
              console.log("Preserving existing chapters as secondary:", existingChapterIds);
            }
          }
        }
      } catch (err) {
        console.error("Error looking up existing user:", err.message);
      }
    }

    console.log("Sending to Solidarity Tech:", JSON.stringify(stUser, null, 2));

    try {
      let response = await fetch(`${SOLIDARITY_TECH_API}/users`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.SOLIDARITY_TECH_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(stUser),
      });

      let body = await response.text();
      console.log("ST API response:", response.status, body);

      // If phone number caused a validation error, retry without it
      if (response.status === 422 && body.includes("phone_number") && stUser.phone_number) {
        console.log("Retrying without phone_number");
        const { phone_number, ...userWithoutPhone } = stUser;
        response = await fetch(`${SOLIDARITY_TECH_API}/users`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SOLIDARITY_TECH_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(userWithoutPhone),
        });
        body = await response.text();
        console.log("ST API retry response:", response.status, body);
      }
    } catch (err) {
      console.error("ST API error:", err.message);
    }
  }
}

function buildSolidarityTechUser(person, anTags, env) {
  const user = {};

  // Chapter ID is required for new users in Solidarity Tech
  if (env.SOLIDARITY_TECH_CHAPTER_ID) {
    user.chapter_id = parseInt(env.SOLIDARITY_TECH_CHAPTER_ID, 10);
    // Ensure this chapter becomes the primary chapter, even for existing users
    user.set_exclusive_chapter = true;
  }

  // Name
  if (person.given_name) user.first_name = person.given_name;
  if (person.family_name) user.last_name = person.family_name;

  // Email - get the primary one
  if (person.email_addresses && person.email_addresses.length > 0) {
    const primary = person.email_addresses.find((e) => e.primary) || person.email_addresses[0];
    user.email = primary.address;
  }

  // Phone - get the primary one
  if (person.phone_numbers && person.phone_numbers.length > 0) {
    const primary = person.phone_numbers.find((p) => p.primary) || person.phone_numbers[0];
    if (primary.number) {
      user.phone_number = primary.number;
    }
  }

  // Address
  if (person.postal_addresses && person.postal_addresses.length > 0) {
    const primary = person.postal_addresses.find((a) => a.primary) || person.postal_addresses[0];
    user.address = {};
    if (primary.address_lines && primary.address_lines[0]) {
      user.address.address1 = primary.address_lines[0];
    }
    if (primary.address_lines && primary.address_lines[1]) {
      user.address.address2 = primary.address_lines[1];
    }
    if (primary.locality) user.address.city = primary.locality;
    if (primary.region) user.address.state = primary.region;
    if (primary.postal_code) user.address.zip_code = primary.postal_code;
    if (primary.country) user.address.country = primary.country;
    if (primary.location) {
      if (primary.location.latitude) user.address.latitude = primary.location.latitude;
      if (primary.location.longitude) user.address.longitude = primary.location.longitude;
    }
  }

  // Language
  if (person.languages_spoken && person.languages_spoken[0]) {
    user.preferred_language = person.languages_spoken[0];
  }

  // Custom fields → custom_user_properties
  const cf = person.custom_fields || {};
  const customProps = {};

  // AN sets each selected option as its own field with value "1"
  const campusRoles = ["Undergraduate student", "Graduate student", "Faculty/staff", "Student worker", "Alumni", "Other"];
  const selectedRoles = campusRoles.filter((role) => cf[role]);
  if (selectedRoles.length > 0) {
    customProps["campus-role"] = selectedRoles;
  }

  if (cf.grad_year) customProps["graduation-year"] = cf.grad_year;

  // Sync Action Network tags → an-tag-binghamton-university
  if (anTags.length > 0) {
    customProps["an-tag-binghamton-university"] = anTags;
  }

  if (Object.keys(customProps).length > 0) {
    user.custom_user_properties = customProps;
  }

  return user;
}
